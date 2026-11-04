import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

const cfg = new pulumi.Config();
const grafanaPassword = cfg.requireSecret("grafanaPassword");
const appNs = new k8s.core.v1.Namespace("guestbook-namespace", {metadata: {name: "guestbook"}});
const monitorNs = new k8s.core.v1.Namespace("monitoring-namespace", {metadata: {name: "monitoring"}});

const labels = (app: string) => ({app});
const redisMaster = new k8s.apps.v1.Deployment("redis-master", {
  metadata: {namespace: appNs.metadata.name},
  spec: {replicas: 1, selector: {matchLabels: labels("redis-master")}, template: {
    metadata: {labels: labels("redis-master")}, spec: {containers: [
      {name: "redis", image: "redis:7.2-alpine", ports: [{containerPort: 6379}],
       resources: {requests: {cpu: "50m", memory: "64Mi"}, limits: {memory: "256Mi"}}},
      {name: "redis-exporter", image: "oliver006/redis_exporter:v1.67.0", ports: [{name: "metrics", containerPort: 9121}],
       env: [{name: "REDIS_ADDR", value: "redis://localhost:6379"}]}
    ]}}}
  }
});
const masterSvc = new k8s.core.v1.Service("redis-master-service", {
  metadata: {name: "redis-master", namespace: appNs.metadata.name, labels: labels("redis-master")},
  spec: {selector: labels("redis-master"), ports: [{name: "redis", port: 6379, targetPort: 6379}, {name: "metrics", port: 9121, targetPort: "metrics"}]}
});
const redisReplica = new k8s.apps.v1.Deployment("redis-replica", {
  metadata: {namespace: appNs.metadata.name},
  spec: {replicas: 2, selector: {matchLabels: labels("redis-replica")}, template: {
    metadata: {labels: labels("redis-replica")}, spec: {containers: [
      {name: "redis", image: "redis:7.2-alpine", command: ["redis-server", "--replicaof", "redis-master", "6379"],
       ports: [{containerPort: 6379}], resources: {requests: {cpu: "50m", memory: "64Mi"}, limits: {memory: "256Mi"}}},
      {name: "redis-exporter", image: "oliver006/redis_exporter:v1.67.0", ports: [{name: "metrics", containerPort: 9121}],
       env: [{name: "REDIS_ADDR", value: "redis://localhost:6379"}]}
    ]}}}
  }
}, {dependsOn: [masterSvc, redisMaster]});
const replicaSvc = new k8s.core.v1.Service("redis-replica-service", {
  metadata: {name: "redis-replica", namespace: appNs.metadata.name, labels: labels("redis-replica")},
  spec: {selector: labels("redis-replica"), ports: [{name: "redis", port: 6379, targetPort: 6379}, {name: "metrics", port: 9121, targetPort: "metrics"}]}
});
const frontend = new k8s.apps.v1.Deployment("frontend", {
  metadata: {namespace: appNs.metadata.name},
  spec: {replicas: 3, selector: {matchLabels: labels("frontend")}, template: {
    metadata: {labels: labels("frontend")}, spec: {containers: [{
      name: "frontend", image: "gcr.io/google-samples/gb-frontend:v5",
      ports: [{name: "http", containerPort: 80}],
      env: [{name: "GET_HOSTS_FROM", value: "dns"}],
      resources: {requests: {cpu: "50m", memory: "64Mi"}, limits: {memory: "256Mi"}},
      readinessProbe: {httpGet: {path: "/", port: 80}, initialDelaySeconds: 5, periodSeconds: 10}
    }]}}
  }
}, {dependsOn: [masterSvc, replicaSvc]});
const frontendSvc = new k8s.core.v1.Service("frontend-service", {
  metadata: {name: "frontend", namespace: appNs.metadata.name, labels: labels("frontend")},
  spec: {type: "LoadBalancer", selector: labels("frontend"), ports: [{name: "http", port: 80, targetPort: "http"}]}
});

const stack = new k8s.helm.v3.Release("observability", {
  name: "observability", chart: "kube-prometheus-stack", version: "92.17.1",
  repositoryOpts: {repo: "https://prometheus-community.github.io/helm-charts"},
  namespace: monitorNs.metadata.name, timeout: 900,
  values: {
    prometheusOperator: {admissionWebhooks: {enabled: false}, tls: {enabled: false}},
    nodeExporter: {enabled: false},
    alertmanager: {enabled: false},
    grafana: {
      adminUser: "admin", adminPassword: grafanaPassword,
      service: {type: "LoadBalancer"},
      sidecar: {dashboards: {enabled: true, label: "grafana_dashboard", searchNamespace: "ALL"}}
    },
    prometheus: {prometheusSpec: {
      retention: "24h",
      serviceMonitorSelectorNilUsesHelmValues: false,
      serviceMonitorNamespaceSelector: {}, serviceMonitorSelector: {},
      probeSelectorNilUsesHelmValues: false,
      probeNamespaceSelector: {}, probeSelector: {},
      resources: {requests: {cpu: "100m", memory: "256Mi"}}
    }}
  }
}, {dependsOn: [monitorNs]});

for (const app of ["redis-master", "redis-replica"]) {
  new k8s.apiextensions.CustomResource(`${app}-monitor`, {
    apiVersion: "monitoring.coreos.com/v1", kind: "ServiceMonitor",
    metadata: {name: `${app}-monitor`, namespace: appNs.metadata.name, labels: {app}},
    spec: {namespaceSelector: {matchNames: ["guestbook"]}, selector: {matchLabels: {app}},
      endpoints: [{port: "metrics", path: "/metrics", interval: "30s"}]}
  }, {dependsOn: [stack, masterSvc, replicaSvc]});
}

const blackbox = new k8s.helm.v3.Release("blackbox", {
  name: "blackbox", chart: "prometheus-blackbox-exporter",
  repositoryOpts: {repo: "https://prometheus-community.github.io/helm-charts"},
  namespace: monitorNs.metadata.name,
  values: {service: {port: 9115}, config: {modules: {http_2xx: {prober: "http", timeout: "5s", http: {preferred_ip_protocol: "ip4"}}}}}
}, {dependsOn: [monitorNs]});
new k8s.apiextensions.CustomResource("frontend-probe", {
  apiVersion: "monitoring.coreos.com/v1", kind: "Probe",
  metadata: {name: "guestbook-frontend", namespace: appNs.metadata.name},
  spec: {jobName: "guestbook-frontend", interval: "30s", module: "http_2xx",
    prober: {url: "blackbox-prometheus-blackbox-exporter.monitoring.svc.cluster.local:9115"},
    targets: {staticConfig: {static: ["http://frontend.guestbook.svc.cluster.local/"]}}}
}, {dependsOn: [stack, blackbox, frontendSvc]});

const dashboard = {
  uid: "guestbook-overview", title: "Guestbook Monitoring", schemaVersion: 39, version: 1,
  refresh: "30s", time: {from: "now-1h", to: "now"},
  panels: [
    {id: 1, title: "Frontend HTTP probe success (1 = healthy)", type: "timeseries", gridPos: {h: 8, w: 12, x: 0, y: 0},
      targets: [{expr: 'probe_success{job="guestbook-frontend"}', legendFormat: "frontend"}]},
    {id: 2, title: "Redis commands per second", type: "timeseries", gridPos: {h: 8, w: 12, x: 12, y: 0},
      targets: [{expr: 'sum(rate(redis_commands_processed_total{namespace="guestbook"}[5m]))', legendFormat: "commands/s"}]},
    {id: 3, title: "Frontend CPU usage (cores)", type: "timeseries", gridPos: {h: 8, w: 12, x: 0, y: 8},
      targets: [{expr: 'sum(rate(container_cpu_usage_seconds_total{namespace="guestbook",pod=~"frontend-.*"}[5m]))', legendFormat: "CPU cores"}]},
    {id: 4, title: "Redis connected clients", type: "timeseries", gridPos: {h: 8, w: 12, x: 12, y: 8},
      targets: [{expr: 'sum(redis_connected_clients{namespace="guestbook"})', legendFormat: "clients"}]}
  ]
};
new k8s.core.v1.ConfigMap("guestbook-dashboard", {
  metadata: {name: "guestbook-dashboard", namespace: monitorNs.metadata.name, labels: {grafana_dashboard: "1"}},
  data: {"guestbook.json": JSON.stringify(dashboard)}
}, {dependsOn: [stack]});

const grafanaService = k8s.core.v1.Service.get("grafana-service", pulumi.interpolate`${monitorNs.metadata.name}/observability-grafana`, {dependsOn: [stack]});
export const grafanaUsername = "admin";
export const grafanaAdminPassword = pulumi.secret(grafanaPassword);
export const grafanaUrl = grafanaService.status.apply(s => {
  const ingress = s?.loadBalancer?.ingress?.[0];
  const host = ingress?.hostname || ingress?.ip;
  return host ? `http://${host}` : "Pending LoadBalancer address; use kubectl port-forward svc/observability-grafana 3000:80 -n monitoring";
});
export const guestbookUrl = frontendSvc.status.apply(s => {
  const ingress = s?.loadBalancer?.ingress?.[0];
  const host = ingress?.hostname || ingress?.ip;
  return host ? `http://${host}` : "Pending LoadBalancer address; use kubectl port-forward svc/frontend 8080:80 -n guestbook";
});
export const prometheusPortForward = "kubectl -n monitoring port-forward svc/observability-kube-prometheus-prometheus 9090:9090";
