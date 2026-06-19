// Package beam provides a Go SDK for Beam sandboxes.
//
// The SDK is sandbox-first: create a Client, create or connect to a Sandbox,
// then use the sandbox's process, filesystem, networking, snapshot, and Docker
// helpers.
//
// Configuration is resolved from explicit options first, then environment
// variables, then the user's Beam/Beta9 config file. The common local-gateway
// setup is:
//
//	client, err := beam.NewClient(ctx,
//		beam.WithToken(os.Getenv("BEAM_TOKEN")),
//		beam.WithGateway("127.0.0.1", 1993),
//		beam.WithTLS(false),
//	)
//
// SandboxConfig.Name is the app name that groups related sandboxes. SandboxID
// returns the generated container ID for a running sandbox.
//
// Process output is consumptive. Process.Stdout.Read and Process.Stderr.Read
// return server-side deltas, so callers that need a complete result should use
// Process.Output or Process.Stream rather than repeatedly reading the same
// stream.
package beam
