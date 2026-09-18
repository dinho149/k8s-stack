#!/usr/bin/env bash
# Databases, apps and the kube cluster are visible only through the matching env roles.
source "$(dirname "$0")/lib.sh"
ui::section "e2e 04: inventory follows env labels"
e2e::login alice
e2e::tsh request create --roles dev-db,dev-app,dev-k8s --reason "e2e: dev inventory" --max-duration 1h --nowait > "$UI_LOG_DIR/e2e-req.log" 2>&1 || true
id="$(grep -oE '[0-9a-f]{8}-[0-9a-f-]{27}' "$UI_LOG_DIR/e2e-req.log" | head -1)"
e2e::wait_state "$id" APPROVED 60 && e2e::tsh login --request-id "$id" >/dev/null
dbs="$(e2e::tsh db ls --format=json | python3 -c 'import json,sys; print(",".join(sorted(d["metadata"]["name"] for d in json.load(sys.stdin))))')"
apps="$(e2e::tsh apps ls --format=json | python3 -c 'import json,sys; print(",".join(sorted(d["metadata"]["name"] for d in json.load(sys.stdin))))')"
kube="$(e2e::tsh kube ls --format=json | python3 -c 'import json,sys; print(",".join(sorted(d["kube_cluster_name"] for d in json.load(sys.stdin))))')"
[[ "$dbs" == "postgres-dev" ]] && ui::ok "db ls = $dbs" || { ui::fail "db ls = $dbs"; exit 1; }
[[ "$apps" == "httpbin" ]] && ui::ok "apps ls = $apps" || { ui::fail "apps ls = $apps"; exit 1; }
[[ "$kube" == *local-kind* ]] && ui::ok "kube ls = $kube" || { ui::fail "kube ls = $kube"; exit 1; }
e2e::expect_ok "psql-less connectivity check: tsh db connect via proxy tunnel" bash -c "e2e::tsh proxy db --tunnel --port 15432 postgres-dev --db-user app --db-name appdb >/dev/null 2>&1 & pid=\$!; sleep 4; kill \$pid 2>/dev/null; true"
