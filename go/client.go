package beam

import (
	"context"
	"crypto/tls"
	"net/http"
	"sync"
	"time"

	pb "github.com/beam-cloud/beta9/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
)

// Client is a Beam API client backed by gRPC services.
type Client struct {
	conn     *grpc.ClientConn
	ownsConn bool
	mu       sync.RWMutex
	config   resolvedConfig
	http     *http.Client
	gateway  pb.GatewayServiceClient
	pod      pb.PodServiceClient
	image    pb.ImageServiceClient
	volume   pb.VolumeServiceClient
}

type clientOptions struct {
	token       string
	tokenSet    bool
	host        string
	port        int
	address     string
	configPath  string
	contextName string
	tls         bool
	tlsSet      bool
	conn        *grpc.ClientConn
	dialOptions []grpc.DialOption
	unary       []grpc.UnaryClientInterceptor
	stream      []grpc.StreamClientInterceptor
	httpClient  *http.Client
}

// Option configures a Client.
type Option func(*clientOptions)

// WithToken sets the Beam API token used for authorization metadata.
func WithToken(token string) Option {
	return func(o *clientOptions) {
		o.token = token
		o.tokenSet = true
	}
}

// WithGateway sets the gateway host and port.
func WithGateway(host string, port int) Option {
	return func(o *clientOptions) {
		o.host = host
		o.port = port
	}
}

// WithAddress sets the gateway address as "host:port".
func WithAddress(address string) Option {
	return func(o *clientOptions) {
		o.address = address
	}
}

// WithConfigPath sets the Beam/Beta9 config file path used for defaults.
func WithConfigPath(path string) Option {
	return func(o *clientOptions) {
		o.configPath = path
	}
}

// WithConfigContext sets the named config context to load.
func WithConfigContext(name string) Option {
	return func(o *clientOptions) {
		o.contextName = name
	}
}

// WithTLS controls whether the gateway connection uses TLS.
func WithTLS(enabled bool) Option {
	return func(o *clientOptions) {
		o.tls = enabled
		o.tlsSet = true
	}
}

// WithDialOptions appends raw gRPC dial options after SDK defaults.
func WithDialOptions(opts ...grpc.DialOption) Option {
	return func(o *clientOptions) {
		o.dialOptions = append(o.dialOptions, opts...)
	}
}

// WithUnaryInterceptors appends unary client interceptors after SDK auth.
func WithUnaryInterceptors(interceptors ...grpc.UnaryClientInterceptor) Option {
	return func(o *clientOptions) {
		o.unary = append(o.unary, interceptors...)
	}
}

// WithStreamInterceptors appends stream client interceptors after SDK auth.
func WithStreamInterceptors(interceptors ...grpc.StreamClientInterceptor) Option {
	return func(o *clientOptions) {
		o.stream = append(o.stream, interceptors...)
	}
}

// WithGRPCConn uses an existing gRPC connection. The SDK will not close it.
func WithGRPCConn(conn *grpc.ClientConn) Option {
	return func(o *clientOptions) {
		o.conn = conn
	}
}

// WithHTTPClient sets the HTTP client used for presigned object uploads.
func WithHTTPClient(client *http.Client) Option {
	return func(o *clientOptions) {
		o.httpClient = client
	}
}

// NewClient creates a Beam client and dials the configured gateway.
//
// Defaults are resolved from BEAM_TOKEN, BEAM_GATEWAY_HOST, BEAM_GATEWAY_PORT,
// then the corresponding BETA9_* variables, then the user's config file, then
// gateway.beam.cloud:443.
func NewClient(ctx context.Context, opts ...Option) (*Client, error) {
	var options clientOptions
	for _, opt := range opts {
		opt(&options)
	}

	cfg, err := resolveClientConfig(options)
	if err != nil {
		return nil, err
	}
	httpClient := options.httpClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}

	c := &Client{config: cfg, http: httpClient}
	if options.conn != nil {
		c.conn = options.conn
		c.ownsConn = false
		c.initServices()
		return c, nil
	}

	dialOptions := []grpc.DialOption{
		grpc.WithDefaultCallOptions(
			grpc.MaxCallRecvMsgSize(64*1024*1024),
			grpc.MaxCallSendMsgSize(64*1024*1024),
		),
	}
	if cfg.TLS {
		dialOptions = append(dialOptions, grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{
			MinVersion: tls.VersionTLS12,
		})))
	} else {
		dialOptions = append(dialOptions, grpc.WithTransportCredentials(insecure.NewCredentials()))
	}
	unary := append([]grpc.UnaryClientInterceptor{c.authUnaryInterceptor()}, options.unary...)
	stream := append([]grpc.StreamClientInterceptor{c.authStreamInterceptor()}, options.stream...)
	dialOptions = append(dialOptions, grpc.WithChainUnaryInterceptor(unary...))
	dialOptions = append(dialOptions, grpc.WithChainStreamInterceptor(stream...))
	dialOptions = append(dialOptions, options.dialOptions...)

	dialCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	//lint:ignore SA1019 grpc.NewClient does not accept a context for bounding the initial dial.
	conn, err := grpc.DialContext(dialCtx, cfg.address(), dialOptions...)
	if err != nil {
		return nil, sdkError(ErrSandboxConnection, "dial gateway", err.Error(), err)
	}
	c.conn = conn
	c.ownsConn = true
	c.initServices()
	return c, nil
}

func (c *Client) initServices() {
	c.gateway = pb.NewGatewayServiceClient(c.conn)
	c.pod = pb.NewPodServiceClient(c.conn)
	c.image = pb.NewImageServiceClient(c.conn)
	c.volume = pb.NewVolumeServiceClient(c.conn)
}

// Close closes the owned gRPC connection. It is a no-op for clients created
// with WithGRPCConn.
func (c *Client) Close() error {
	if c == nil || c.conn == nil || !c.ownsConn {
		return nil
	}
	return c.conn.Close()
}

// Config returns a copy of the resolved client configuration.
func (c *Client) Config() ClientConfig {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return ClientConfig{
		Token:       c.config.Token,
		GatewayHost: c.config.GatewayHost,
		GatewayPort: c.config.GatewayPort,
		TLS:         c.config.TLS,
		ConfigPath:  c.config.ConfigPath,
		ContextName: c.config.ContextName,
	}
}

// Workspace describes the workspace returned by Authorize.
type Workspace struct {
	ID    string
	Token string
}

// Authorize verifies credentials with the gateway and stores a refreshed token
// when the gateway returns one.
func (c *Client) Authorize(ctx context.Context) (*Workspace, error) {
	res, err := c.gateway.Authorize(ctx, &pb.AuthorizeRequest{})
	if err != nil {
		return nil, wrapError(ErrAuth, "authorize", err)
	}
	if !res.GetOk() {
		return nil, sdkError(ErrAuth, "authorize", res.GetErrorMsg(), nil)
	}
	token := c.currentToken()
	if res.GetNewToken() != "" {
		c.mu.Lock()
		c.config.Token = res.GetNewToken()
		token = c.config.Token
		c.mu.Unlock()
	}
	return &Workspace{ID: res.GetWorkspaceId(), Token: token}, nil
}

func (c *Client) currentToken() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.config.Token
}

func (c *Client) authUnaryInterceptor() grpc.UnaryClientInterceptor {
	return func(ctx context.Context, method string, req, reply any, cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
		if token := c.currentToken(); token != "" {
			ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+token)
		}
		return invoker(ctx, method, req, reply, cc, opts...)
	}
}

func (c *Client) authStreamInterceptor() grpc.StreamClientInterceptor {
	return func(ctx context.Context, desc *grpc.StreamDesc, cc *grpc.ClientConn, method string, streamer grpc.Streamer, opts ...grpc.CallOption) (grpc.ClientStream, error) {
		if token := c.currentToken(); token != "" {
			ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+token)
		}
		return streamer(ctx, desc, cc, method, opts...)
	}
}

func ptrString(v string) *string {
	return &v
}
