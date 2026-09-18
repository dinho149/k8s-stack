package platform

import (
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
)

func (a *API) metrics(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !equalSecret(token, os.Getenv("DOGFOOD_METRICS_TOKEN")) && !equalSecret(token, a.serviceToken) {
		failure(w, ErrForbidden)
		return
	}
	st, err := a.Store.Snapshot()
	if err != nil {
		writeJSON(w, 503, map[string]string{"error": "metrics unavailable"})
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	counts := map[string]int{}
	for _, e := range st.Environments {
		counts[e.Status]++
	}
	keys := []string{}
	for status := range counts {
		keys = append(keys, status)
	}
	sort.Strings(keys)
	fmt.Fprintln(w, "# TYPE dogfood_environments gauge")
	for _, status := range keys {
		fmt.Fprintf(w, "dogfood_environments{status=%q} %d\n", status, counts[status])
	}
	fmt.Fprintln(w, "# TYPE dogfood_launch_duration_seconds histogram")
	for _, phase := range []string{"cluster-ready", "platform-ready", "application-ready"} {
		for _, warm := range []bool{false, true} {
			samples := []float64{}
			sum := 0.0
			for _, op := range st.Operations {
				if op.Action != "deploy" || op.Status != "succeeded" || op.Warm != warm || op.StartedAt == nil {
					continue
				}
				if at, ok := op.Timings[phase]; ok {
					v := at.Sub(*op.StartedAt).Seconds()
					samples = append(samples, v)
					sum += v
				}
			}
			for _, bound := range []float64{10, 30, 60, 120, 180, 300, 600, 1200} {
				count := 0
				for _, v := range samples {
					if v <= bound {
						count++
					}
				}
				fmt.Fprintf(w, "dogfood_launch_duration_seconds_bucket{phase=%q,warm=%q,le=\"%g\"} %d\n", phase, fmt.Sprint(warm), bound, count)
			}
			fmt.Fprintf(w, "dogfood_launch_duration_seconds_bucket{phase=%q,warm=%q,le=\"+Inf\"} %d\n", phase, fmt.Sprint(warm), len(samples))
			fmt.Fprintf(w, "dogfood_launch_duration_seconds_sum{phase=%q,warm=%q} %g\n", phase, fmt.Sprint(warm), sum)
			fmt.Fprintf(w, "dogfood_launch_duration_seconds_count{phase=%q,warm=%q} %d\n", phase, fmt.Sprint(warm), len(samples))
		}
	}
	fmt.Fprintln(w, "# TYPE dogfood_operations_total counter")
	for _, status := range []string{"succeeded", "failed", "superseded"} {
		n := 0
		for _, op := range st.Operations {
			if op.Status == status {
				n++
			}
		}
		fmt.Fprintf(w, "dogfood_operations_total{status=%q} %d\n", status, n)
	}
}
