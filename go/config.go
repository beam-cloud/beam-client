package beam

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	defaultGatewayHost = "gateway.beam.cloud"
	defaultGatewayPort = 443
	defaultContextName = "default"
)

type resolvedConfig struct {
	Token       string
	GatewayHost string
	GatewayPort int
	TLS         bool
	ConfigPath  string
	ContextName string
}

func (c resolvedConfig) address() string {
	return net.JoinHostPort(c.GatewayHost, strconv.Itoa(c.GatewayPort))
}

// ClientConfig is a copy of the resolved client configuration.
type ClientConfig struct {
	Token       string
	GatewayHost string
	GatewayPort int
	TLS         bool
	ConfigPath  string
	ContextName string
}

type iniContext struct {
	token       string
	gatewayHost string
	gatewayPort int
}

func defaultConfigPath() string {
	if p := os.Getenv("BEAM_CONFIG_PATH"); p != "" {
		return expandHome(p)
	}
	if p := os.Getenv("CONFIG_PATH"); p != "" {
		return expandHome(p)
	}
	return filepath.Join(homeDir(), ".beam", "config.ini")
}

func defaultConfigContext() string {
	if name := strings.TrimSpace(os.Getenv("BEAM_CONFIG_CONTEXT")); name != "" {
		return name
	}
	return defaultContextName
}

func homeDir() string {
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		return h
	}
	return "."
}

func expandHome(path string) string {
	if path == "~" {
		return homeDir()
	}
	if strings.HasPrefix(path, "~/") {
		return filepath.Join(homeDir(), path[2:])
	}
	return path
}

func resolveClientConfig(opts clientOptions) (resolvedConfig, error) {
	cfg := resolvedConfig{
		GatewayHost: defaultGatewayHost,
		GatewayPort: defaultGatewayPort,
		TLS:         true,
		ConfigPath:  defaultConfigPath(),
		ContextName: defaultConfigContext(),
	}
	if opts.configPath != "" {
		cfg.ConfigPath = expandHome(opts.configPath)
	}
	if opts.contextName != "" {
		cfg.ContextName = opts.contextName
	}

	if fileCtx, err := readConfigContext(cfg.ConfigPath, cfg.ContextName); err == nil {
		if fileCtx.token != "" {
			cfg.Token = fileCtx.token
		}
		if fileCtx.gatewayHost != "" {
			cfg.GatewayHost = fileCtx.gatewayHost
		}
		if fileCtx.gatewayPort > 0 {
			cfg.GatewayPort = fileCtx.gatewayPort
		}
	} else if !os.IsNotExist(err) {
		return cfg, sdkError(ErrConfig, "load config", err.Error(), err)
	}

	if v := firstEnv("BEAM_TOKEN", "BETA9_TOKEN"); v != "" {
		cfg.Token = v
	}
	if v := firstEnv("BEAM_GATEWAY_HOST", "GATEWAY_HOST", "BETA9_GATEWAY_HOST"); v != "" {
		cfg.GatewayHost = strings.TrimSpace(v)
	}
	if v := firstEnv("BEAM_GATEWAY_PORT", "GATEWAY_PORT", "BETA9_GATEWAY_PORT"); v != "" {
		port, err := strconv.Atoi(strings.TrimSpace(v))
		if err != nil || port <= 0 || port > 65535 {
			return cfg, sdkError(ErrConfig, "load env", fmt.Sprintf("invalid gateway port %q", v), err)
		}
		cfg.GatewayPort = port
	}

	if opts.tokenSet {
		cfg.Token = opts.token
	}
	if opts.host != "" {
		cfg.GatewayHost = opts.host
	}
	if opts.port != 0 {
		if opts.port < 0 || opts.port > 65535 {
			return cfg, sdkError(ErrConfig, "apply options", "gateway port must be between 1 and 65535", nil)
		}
		cfg.GatewayPort = opts.port
	}
	if opts.address != "" {
		host, portText, err := net.SplitHostPort(opts.address)
		if err != nil {
			return cfg, sdkError(ErrConfig, "apply options", "address must be host:port", err)
		}
		port, err := strconv.Atoi(portText)
		if err != nil || port <= 0 || port > 65535 {
			return cfg, sdkError(ErrConfig, "apply options", "address port must be between 1 and 65535", err)
		}
		cfg.GatewayHost = host
		cfg.GatewayPort = port
	}
	if opts.tlsSet {
		cfg.TLS = opts.tls
	} else {
		cfg.TLS = cfg.GatewayPort == 443
	}
	return cfg, nil
}

func firstEnv(names ...string) string {
	for _, name := range names {
		if v := os.Getenv(name); v != "" {
			return v
		}
	}
	return ""
}

func readConfigContext(path, contextName string) (iniContext, error) {
	f, err := os.Open(path)
	if err != nil {
		return iniContext{}, err
	}
	defer f.Close()

	contexts := map[string]iniContext{}
	section := defaultContextName
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.TrimSpace(line[1 : len(line)-1])
			if section == "" {
				section = defaultContextName
			}
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		val = strings.Trim(strings.TrimSpace(val), `"'`)
		ctx := contexts[section]
		switch key {
		case "token":
			ctx.token = val
		case "gateway_host":
			ctx.gatewayHost = val
		case "gateway_port":
			if val != "" {
				port, err := strconv.Atoi(val)
				if err != nil {
					return iniContext{}, err
				}
				ctx.gatewayPort = port
			}
		}
		contexts[section] = ctx
	}
	if err := scanner.Err(); err != nil {
		return iniContext{}, err
	}

	if contextName == "" {
		contextName = defaultContextName
	}
	if ctx, ok := contexts[contextName]; ok {
		return ctx, nil
	}
	if ctx, ok := contexts[strings.ToUpper(contextName[:1])+contextName[1:]]; ok {
		return ctx, nil
	}
	return iniContext{}, nil
}
