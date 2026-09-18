import { stringify } from 'yaml';

export function backendFiles(language: 'Python' | 'Go'): Record<string, string> {
  if (language === 'Python')
    return {
      'requirements.txt': 'fastapi==0.141.1\nuvicorn==0.53.0\npytest==9.1.1\nhttpx==0.28.1\n',
      '.gitignore': '.venv/\n__pycache__/\n.pytest_cache/\n.env\n.env.*\n.dogfood/\n',
      'main.py':
        'from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/")\ndef greeting():\n    return {"message": "Hello, world!"}\n',
      'test_main.py':
        'from fastapi.testclient import TestClient\nfrom main import app\n\n\ndef test_greeting():\n    response = TestClient(app).get("/")\n    assert response.status_code == 200\n    assert response.json() == {"message": "Hello, world!"}\n',
      'dogfood.yaml': stringify({
        version: 1,
        setup: [
          { name: 'Create virtual environment', command: 'python3', args: ['-m', 'venv', '.venv'] },
          {
            name: 'Install dependencies',
            command: '.venv/bin/python',
            args: ['-m', 'pip', 'install', '-r', 'requirements.txt'],
            timeoutSeconds: 600,
          },
        ],
        dev: {
          name: 'Development server',
          command: '.venv/bin/python',
          args: ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '{port}'],
        },
        checks: [{ name: 'API tests', command: '.venv/bin/python', args: ['-m', 'pytest'] }],
      }),
    };
  return {
    'go.mod': 'module example.com/dogfood-app\n\ngo 1.25.0\n',
    '.gitignore': 'bin/\n.env\n.env.*\n.dogfood/\n',
    'main.go': `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"
)

func handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"message": "Hello, world!"})
	})
	return mux
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	server := &http.Server{Addr: "127.0.0.1:" + port, Handler: handler(), ReadHeaderTimeout: 5 * time.Second}
	log.Fatal(server.ListenAndServe())
}
`,
    'main_test.go': `package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGreeting(t *testing.T) {
	response := httptest.NewRecorder()
	handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["message"] != "Hello, world!" {
		t.Fatalf("unexpected greeting: %v", body)
	}
}
`,
    'dogfood.yaml': stringify({
      version: 1,
      setup: [{ name: 'Check Go toolchain', command: 'go', args: ['version'] }],
      dev: { name: 'Development server', command: 'go', args: ['run', '.'] },
      checks: [
        { name: 'Handler tests', command: 'go', args: ['test', './...'] },
        { name: 'Build', command: 'go', args: ['build', '-o', 'bin/server', '.'] },
      ],
    }),
  };
}
