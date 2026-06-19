package beam

import (
	"context"

	pb "github.com/beam-cloud/beta9/proto"
)

// VolumeMount is implemented by Beam volume and cloud bucket mounts.
type VolumeMount interface {
	prepare(ctx context.Context, c *Client) (*pb.Volume, error)
}

// Volume is a persistent Beam volume mount.
type Volume struct {
	Name      string
	MountPath string
}

// NewVolume returns a Beam volume mounted at mountPath.
func NewVolume(name, mountPath string) Volume {
	return Volume{Name: name, MountPath: mountPath}
}

func (v Volume) prepare(ctx context.Context, c *Client) (*pb.Volume, error) {
	if v.Name == "" {
		return nil, sdkError(ErrValidation, "prepare volume", "volume name is required", nil)
	}
	if v.MountPath == "" {
		return nil, sdkError(ErrValidation, "prepare volume", "volume mount path is required", nil)
	}
	res, err := c.volume.GetOrCreateVolume(ctx, &pb.GetOrCreateVolumeRequest{Name: v.Name})
	if err != nil {
		return nil, wrapError(ErrSandboxConnection, "prepare volume", err)
	}
	if !res.GetOk() {
		return nil, sdkError(ErrSandboxConnection, "prepare volume", res.GetErrMsg(), nil)
	}
	return &pb.Volume{Id: res.GetVolume().GetId(), MountPath: v.MountPath}, nil
}

// CloudBucket is an external object-storage bucket mounted into a sandbox.
type CloudBucket struct {
	MountPath string
	Config    CloudBucketConfig
}

// CloudBucketConfig configures an external object-storage bucket mount.
type CloudBucketConfig struct {
	BucketName     string
	AccessKey      string
	SecretKey      string
	EndpointURL    string
	Region         string
	ReadOnly       bool
	ForcePathStyle bool
}

// NewCloudBucket returns a cloud bucket mount.
func NewCloudBucket(mountPath string, config CloudBucketConfig) CloudBucket {
	return CloudBucket{MountPath: mountPath, Config: config}
}

func (b CloudBucket) prepare(ctx context.Context, c *Client) (*pb.Volume, error) {
	_ = ctx
	_ = c
	if b.MountPath == "" {
		return nil, sdkError(ErrValidation, "prepare cloud bucket", "bucket mount path is required", nil)
	}
	if b.Config.BucketName == "" {
		return nil, sdkError(ErrValidation, "prepare cloud bucket", "bucket name is required", nil)
	}
	return &pb.Volume{
		MountPath: b.MountPath,
		Config: &pb.MountPointConfig{
			BucketName:     b.Config.BucketName,
			AccessKey:      b.Config.AccessKey,
			SecretKey:      b.Config.SecretKey,
			EndpointUrl:    b.Config.EndpointURL,
			Region:         b.Config.Region,
			ReadOnly:       b.Config.ReadOnly,
			ForcePathStyle: b.Config.ForcePathStyle,
		},
	}, nil
}

// PoolConfig selects or configures the worker pool used for a sandbox.
type PoolConfig struct {
	Name           string
	GPU            []string
	Nodes          uint32
	TTL            string
	MaxSpend       float64
	Providers      []string
	Regions        []string
	MinReliability float64
	Selector       string
	Mode           string
	Transport      string
	Fallback       string
	Priority       int32
	OfferID        string
}

func (p *PoolConfig) proto() *pb.PoolConfig {
	if p == nil {
		return nil
	}
	return &pb.PoolConfig{
		Name:           p.Name,
		Gpu:            append([]string{}, p.GPU...),
		Nodes:          p.Nodes,
		Ttl:            p.TTL,
		MaxSpend:       p.MaxSpend,
		Providers:      append([]string{}, p.Providers...),
		Regions:        append([]string{}, p.Regions...),
		MinReliability: p.MinReliability,
		Selector:       p.Selector,
		Mode:           p.Mode,
		Transport:      p.Transport,
		Fallback:       p.Fallback,
		Priority:       p.Priority,
		OfferId:        p.OfferID,
	}
}
