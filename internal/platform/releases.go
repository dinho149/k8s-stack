package platform

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"time"
)

var repoRE = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

type PromotionRequest struct {
	Target   string `json:"target"`
	Image    string `json:"image"`
	Revision string `json:"revision"`
}

func (s *Store) RequestPromotion(ctx context.Context, u Identity, r PromotionRequest) (map[string]string, error) {
	if r.Target != "dev" && r.Target != "staging" && r.Target != "prod" {
		return nil, ErrInvalid
	}
	if !imageRE.MatchString(r.Image) || !revisionRE.MatchString(r.Revision) {
		return nil, ErrInvalid
	}
	if u.Role != "admin" && (u.Role != "developer" || r.Target != "dev") {
		return nil, ErrForbidden
	}
	repo := os.Getenv("STACK_GITHUB_REPOSITORY")
	token := os.Getenv("STACK_GITHUB_TOKEN")
	if !repoRE.MatchString(repo) || token == "" {
		return nil, errors.New("release integration is not configured")
	}
	body, _ := json.Marshal(map[string]any{"ref": "main", "inputs": map[string]string{"target": r.Target, "image": r.Image, "revision": r.Revision, "requested_by": u.Subject}})
	req, err := http.NewRequestWithContext(ctx, "POST", "https://api.github.com/repos/"+repo+"/actions/workflows/promote.yaml/dispatches", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/vnd.github+json")
	client := http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, errors.New("release workflow dispatch failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 204 {
		return nil, fmt.Errorf("release workflow rejected (%d)", resp.StatusCode)
	}
	err = s.transaction(func(st *State) error {
		audit(st, s.Now(), u.Subject, "promote", r.Target+":"+r.Revision, "workflow-requested")
		return nil
	})
	if err != nil {
		return nil, err
	}
	return map[string]string{"status": "workflow-requested", "url": "https://github.com/" + repo + "/actions/workflows/promote.yaml", "note": "GitHub environment protection rules control approval. This is not a completed deployment."}, nil
}
