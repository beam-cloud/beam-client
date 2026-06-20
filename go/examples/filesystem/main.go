package main

import (
	"context"
	"fmt"
	"log"
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
	})
	if err != nil {
		log.Fatal(err)
	}
	defer sandbox.Terminate(context.Background())

	if err := sandbox.FS.Mkdir(ctx, "/workspace/data", 0o755); err != nil {
		log.Fatal(err)
	}
	if err := sandbox.FS.WriteText(ctx, "/workspace/data/message.txt", "hello from the Go SDK\n", 0o644); err != nil {
		log.Fatal(err)
	}
	if err := sandbox.FS.Replace(ctx, "/workspace/data", "Go SDK", "Beam sandbox"); err != nil {
		log.Fatal(err)
	}

	info, err := sandbox.FS.Stat(ctx, "/workspace/data/message.txt")
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("%s: %d bytes\n", info.Name, info.Size)

	matches, err := sandbox.FS.Find(ctx, "/workspace/data", "Beam")
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("matches: %d\n", len(matches))

	text, err := sandbox.FS.ReadText(ctx, "/workspace/data/message.txt")
	if err != nil {
		log.Fatal(err)
	}
	fmt.Print(text)
}
