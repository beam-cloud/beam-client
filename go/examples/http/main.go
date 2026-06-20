package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"

	beam "github.com/beam-cloud/beam-client/go"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	client, err := beam.NewClient(ctx)
	if err != nil {
		log.Fatal(err)
	}
	defer client.Close()

	sandbox, err := client.CreateSandbox(ctx, beam.SandboxConfig{
		Name:      "go-sdk-examples",
		Image:     beam.NewImage(beam.WithPythonVersion("python3.11")),
		CPU:       1,
		MemoryMiB: 256,
		Ports:     []int{8000},
	})
	if err != nil {
		log.Fatal(err)
	}
	defer sandbox.Terminate(context.Background())

	if err := sandbox.FS.Upload(ctx, "/workspace/index.html", []byte("hello over HTTP\n"), 0o644); err != nil {
		log.Fatal(err)
	}

	server, err := sandbox.Exec(ctx, []string{"python3", "-m", "http.server", "8000", "--bind", "0.0.0.0"}, beam.ExecOptions{Workdir: "/workspace"})
	if err != nil {
		log.Fatal(err)
	}
	defer server.Kill(context.Background())

	url, err := sandbox.ExposePort(ctx, 8000)
	if err != nil {
		log.Fatal(err)
	}
	urls, err := sandbox.ListURLs(ctx)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("port 8000: %s\n", urls[8000])

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		log.Fatal(err)
	}
	if token := client.Config().Token; token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("%s", body)
}
