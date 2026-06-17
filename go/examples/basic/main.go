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
		Name:      "go-basic",
		App:       "go-sdk-examples",
		Image:     beam.NewImage(beam.WithPythonVersion("python3.11")),
		CPU:       1,
		MemoryMiB: 256,
		KeepWarm:  10 * time.Minute,
	})
	if err != nil {
		log.Fatal(err)
	}
	defer sandbox.Terminate(context.Background())

	if err := sandbox.WaitReady(ctx); err != nil {
		log.Fatal(err)
	}

	result, err := sandbox.RunCode(ctx, `print("hello from Beam")`, beam.ExecOptions{})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Print(result.Stdout)

	proc, err := sandbox.Exec(ctx, []string{"sh", "-lc", "for i in 1 2 3; do echo tick-$i; sleep 1; done"}, beam.ExecOptions{})
	if err != nil {
		log.Fatal(err)
	}
	exitCode, err := proc.Stream(ctx, func(entry beam.LogEntry) {
		fmt.Print(entry.Data)
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("stream exited with %d\n", exitCode)
}
