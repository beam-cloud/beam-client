package main

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	beam "github.com/beam-cloud/beam-client/go"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
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
	})
	if err != nil {
		log.Fatal(err)
	}
	defer sandbox.Terminate(context.Background())

	if err := sandbox.FS.Upload(ctx, "/workspace/checkpoint.txt", []byte("state from before snapshot"), 0o644); err != nil {
		log.Fatal(err)
	}

	checkpointID, err := sandbox.SnapshotMemory(ctx)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("checkpoint:", checkpointID)

	restored, err := client.CreateSandboxFromMemorySnapshot(ctx, checkpointID)
	if err != nil {
		log.Fatal(err)
	}
	defer restored.Terminate(context.Background())

	result, err := restored.RunCode(ctx, `print(open("/workspace/checkpoint.txt").read())`, beam.ExecOptions{})
	if err != nil {
		log.Fatal(err)
	}
	if result.ExitCode != 0 {
		log.Fatalf("restore check failed: %s", result.Stderr)
	}
	fmt.Println(strings.TrimSpace(result.Stdout))
}
