package beam

import (
	"os"
	"path/filepath"
	"testing"
)

func clearConfigEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"BEAM_TOKEN",
		"BETA9_TOKEN",
		"BEAM_GATEWAY_HOST",
		"GATEWAY_HOST",
		"BETA9_GATEWAY_HOST",
		"BEAM_GATEWAY_PORT",
		"GATEWAY_PORT",
		"BETA9_GATEWAY_PORT",
		"BEAM_CONFIG_PATH",
		"CONFIG_PATH",
		"BEAM_CONFIG_CONTEXT",
	} {
		t.Setenv(key, "")
	}
}

func TestReadConfigContext(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.ini")
	content := "[default]\n" +
		"token = file-token\n" +
		"gateway_host = file-gateway\n" +
		"gateway_port = 1993\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, err := readConfigContext(path, "default")
	if err != nil {
		t.Fatal(err)
	}
	if ctx.token != "file-token" || ctx.gatewayHost != "file-gateway" || ctx.gatewayPort != 1993 {
		t.Fatalf("unexpected context: %#v", ctx)
	}
}

func TestResolveClientConfigEnvOverridesFile(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("BEAM_TOKEN", "env-token")
	t.Setenv("BEAM_GATEWAY_HOST", "env-gateway")
	t.Setenv("BEAM_GATEWAY_PORT", "8443")
	cfg, err := resolveClientConfig(clientOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Token != "env-token" || cfg.GatewayHost != "env-gateway" || cfg.GatewayPort != 8443 {
		t.Fatalf("unexpected config: %#v", cfg)
	}
	if cfg.TLS {
		t.Fatalf("expected TLS to default false for non-443 port")
	}
}

func TestResolveClientConfigExplicitPathAndContext(t *testing.T) {
	clearConfigEnv(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "config.ini")
	content := "[default]\n" +
		"token = default-token\n" +
		"gateway_host = gateway.beam.cloud\n" +
		"gateway_port = 443\n" +
		"[local]\n" +
		"token = local-token\n" +
		"gateway_host = 0.0.0.0\n" +
		"gateway_port = 1993\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := resolveClientConfig(clientOptions{configPath: path, contextName: "local"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Token != "local-token" || cfg.GatewayHost != "0.0.0.0" || cfg.GatewayPort != 1993 {
		t.Fatalf("unexpected config: %#v", cfg)
	}
	if cfg.TLS {
		t.Fatalf("expected local config to use insecure gRPC")
	}
}

func TestResolveClientConfigBeta9EnvFallbacks(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("BETA9_TOKEN", "beta9-token")
	t.Setenv("BETA9_GATEWAY_HOST", "127.0.0.1")
	t.Setenv("BETA9_GATEWAY_PORT", "1993")
	cfg, err := resolveClientConfig(clientOptions{configPath: filepath.Join(t.TempDir(), "missing.ini")})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Token != "beta9-token" || cfg.GatewayHost != "127.0.0.1" || cfg.GatewayPort != 1993 {
		t.Fatalf("unexpected config: %#v", cfg)
	}
}

func TestResolveClientConfigBeamClientGatewayAliases(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("GATEWAY_HOST", "localhost")
	t.Setenv("GATEWAY_PORT", "1993")
	cfg, err := resolveClientConfig(clientOptions{configPath: filepath.Join(t.TempDir(), "missing.ini")})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GatewayHost != "localhost" || cfg.GatewayPort != 1993 {
		t.Fatalf("unexpected config: %#v", cfg)
	}
}
