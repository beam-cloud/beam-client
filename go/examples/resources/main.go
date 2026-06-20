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
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	client, err := beam.NewClient(ctx)
	if err != nil {
		log.Fatal(err)
	}
	defer client.Close()

	config := beam.SandboxConfig{
		Name:      "go-sdk-resources",
		Image:     beam.NewImage(beam.WithPythonVersion("python3.11")),
		CPU:       1,
		MemoryMiB: 512,
		KeepWarm:  10 * time.Minute,
		Env: map[string]string{
			"BEAM_EXAMPLE": "resources",
		},
	}

	if gpu := os.Getenv("BEAM_EXAMPLE_GPU"); gpu != "" {
		config.GPU = gpu
		config.GPUCount = 1
	}
	if secret := os.Getenv("BEAM_EXAMPLE_SECRET"); secret != "" {
		config.Secrets = append(config.Secrets, secret)
	}
	if volumeName := os.Getenv("BEAM_EXAMPLE_VOLUME"); volumeName != "" {
		config.Volumes = append(config.Volumes, beam.NewVolume(volumeName, "/mnt/data"))
	}
	if bucketName := os.Getenv("BEAM_EXAMPLE_BUCKET"); bucketName != "" {
		config.Volumes = append(config.Volumes, beam.NewCloudBucket("/mnt/bucket", beam.CloudBucketConfig{
			BucketName: bucketName,
			Region:     os.Getenv("BEAM_EXAMPLE_BUCKET_REGION"),
			ReadOnly:   true,
		}))
	}

	sandbox, err := client.CreateSandbox(ctx, config)
	if err != nil {
		log.Fatal(err)
	}
	defer sandbox.Terminate(context.Background())

	result, err := sandbox.RunCode(ctx, strings.TrimSpace(`
import os
from pathlib import Path

print("env:", os.environ["BEAM_EXAMPLE"])
for path in ("/mnt/data", "/mnt/bucket"):
    print(path, "mounted" if Path(path).exists() else "not mounted")
`), beam.ExecOptions{})
	if err != nil {
		log.Fatal(err)
	}
	if result.ExitCode != 0 {
		log.Fatalf("resource check failed: %s", result.Stderr)
	}
	fmt.Print(result.Stdout)
}
