package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	beam "github.com/beam-cloud/beam-client/go"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()

	client, err := beam.NewClient(ctx)
	if err != nil {
		log.Fatal(err)
	}
	defer client.Close()

	var pool *beam.PoolConfig
	if name := os.Getenv("BEAM_DOCKER_POOL"); name != "" {
		pool = &beam.PoolConfig{Name: name}
	}

	sandbox, err := client.CreateSandbox(ctx, beam.SandboxConfig{
		Name:          "go-docker",
		App:           "go-sdk-examples",
		Image:         beam.NewImage(beam.WithPythonVersion("python3.11")).WithDocker(),
		CPU:           2,
		MemoryMiB:     2048,
		DockerEnabled: true,
		Pool:          pool,
	})
	if err != nil {
		log.Fatal(err)
	}
	defer sandbox.Terminate(context.Background())

	if err := sandbox.WaitReady(ctx); err != nil {
		log.Fatal(err)
	}

	version, err := sandbox.Docker.Raw(ctx, "version", "--format", "{{.Server.Version}}")
	if err != nil {
		log.Fatal(err)
	}
	versionResult, err := version.Output(ctx)
	if err != nil {
		log.Fatal(err)
	}
	if versionResult.ExitCode != 0 {
		log.Fatalf("docker version failed: %s", versionResult.Stderr)
	}
	fmt.Println("docker:", strings.TrimSpace(versionResult.Stdout))

	run, err := sandbox.Docker.Run(ctx, "hello-world", beam.DockerRunOptions{Remove: true})
	if err != nil {
		log.Fatal(err)
	}
	result, err := run.Output(ctx)
	if err != nil {
		log.Fatal(err)
	}
	if result.ExitCode != 0 {
		log.Fatalf("docker run failed: %s", result.Stderr)
	}
	fmt.Print(result.Stdout)
}
