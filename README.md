# Guestbook Monitoring

Pulumi TypeScript project that deploys the Kubernetes Guestbook application with Redis, Prometheus, Grafana, and HTTP availability monitoring.

## Components

- Guestbook frontend with a LoadBalancer service
- Redis master and two replicas, each with a Redis exporter sidecar
- Prometheus and Grafana deployed through the kube-prometheus-stack Helm chart
- Redis ServiceMonitors and a Blackbox Exporter Probe for frontend HTTP checks
- Grafana dashboard for frontend availability, Redis activity, connected clients, and frontend CPU usage

The Guestbook frontend does not expose a native Prometheus HTTP request counter. The HTTP probe measures availability; kubelet/cAdvisor supplies CPU usage metrics.

## Prerequisites

- Node.js and npm
- Pulumi CLI
- kubectl configured for a working Kubernetes cluster
- Permission to install Helm releases and Prometheus Operator CRDs

## Deployment

```powershell
npm install
pulumi stack init dev
pulumi config set --secret grafanaPassword "YOUR_PASSWORD"
pulumi up
```

If the `dev` stack already exists, use `pulumi stack select dev` instead of initializing it again.

Check the resources:

```powershell
kubectl get pods -n guestbook
kubectl get pods -n monitoring
kubectl get servicemonitors -n guestbook
kubectl get probes -n guestbook
```

## Grafana access

The Grafana service is configured as a LoadBalancer. To inspect its address:

```powershell
kubectl get svc observability-grafana -n monitoring
pulumi stack output grafanaUrl
```

For local access, open a separate terminal and run:

```powershell
kubectl port-forward -n monitoring svc/observability-grafana 3000:80
```

Open http://localhost:3000.

- Username: `admin`
- Password: the value configured using `pulumi config set --secret grafanaPassword`

Retrieve the password from Pulumi when necessary:

```powershell
pulumi stack output grafanaAdminPassword --show-secrets
```

Do not commit the password or a Pulumi stack configuration file containing secrets.

## Verify Prometheus metrics

Start a separate terminal:

```powershell
kubectl port-forward -n monitoring svc/observability-kube-prometheus-prometheus 9090:9090
```

Open http://localhost:9090 and run these PromQL queries in the Prometheus expression browser:

```promql
redis_up
probe_success{job="guestbook-frontend"}
redis_connected_clients
rate(redis_commands_processed_total[5m])
sum(rate(container_cpu_usage_seconds_total{namespace="guestbook",pod=~"frontend-.*"}[5m]))
```

A `redis_up` value of `1` means the exporter can reach Redis. A `probe_success` value of `1` means the frontend HTTP check passed. CPU usage is measured in CPU cores.

## Dashboard

In Grafana, open **Dashboards → Guestbook Monitoring**. The dashboard is loaded from a Kubernetes ConfigMap through Grafana's dashboard sidecar.

## Guestbook access

```powershell
kubectl port-forward -n guestbook svc/frontend 8080:80
```

Open http://localhost:8080.

## Cleanup

```powershell
pulumi destroy
```

The Grafana LoadBalancer is intended for demonstration. Restrict access and configure HTTPS before using it in a public environment.
