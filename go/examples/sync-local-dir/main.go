package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	beam "github.com/beam-cloud/beam-client/go"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	dir, err := os.MkdirTemp("", "beam-go-sync-*")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(dir)

	if err := os.WriteFile(filepath.Join(dir, "input.txt"), []byte("synced from local dir\n"), 0o644); err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".beamignore"), []byte("ignored.txt\n"), 0o644); err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ignored.txt"), []byte("this file is ignored\n"), 0o644); err != nil {
		log.Fatal(err)
	}

	client, err := beam.NewClient(ctx)
	if err != nil {
		log.Fatal(err)
	}
	defer client.Close()

	sandbox, err := client.CreateSandbox(ctx, beam.SandboxConfig{
		Name:         "go-sync-local-dir",
		App:          "go-sdk-examples",
		Image:        beam.NewImage(beam.WithPythonVersion("python3.11")),
		CPU:          1,
		MemoryMiB:    256,
		Workdir:      dir,
		SyncLocalDir: true,
	})
	if err != nil {
		log.Fatal(err)
	}
	defer sandbox.Terminate(context.Background())

	if err := sandbox.WaitReady(ctx); err != nil {
		log.Fatal(err)
	}

	result, err := sandbox.RunCode(ctx, `print(open("input.txt").read())`, beam.ExecOptions{Workdir: "/mnt/code"})
	if err != nil {
		log.Fatal(err)
	}
	if result.ExitCode != 0 {
		log.Fatalf("read synced file failed: %s", result.Stderr)
	}
	fmt.Println(strings.TrimSpace(result.Stdout))
}
