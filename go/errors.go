package beam

import (
	"errors"
	"fmt"
)

const (
	ErrAuth              = "auth"
	ErrConfig            = "config"
	ErrSandboxConnection = "sandbox_connection"
	ErrProcess           = "process"
	ErrFilesystem        = "filesystem"
	ErrImageBuild        = "image_build"
	ErrValidation        = "validation"
)

// Error is the structured error type returned by the SDK.
type Error struct {
	Code    string
	Op      string
	Message string
	Err     error
}

// Error returns a formatted SDK error string.
func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	msg := e.Message
	if msg == "" && e.Err != nil {
		msg = e.Err.Error()
	}
	if e.Op == "" {
		if e.Code == "" {
			return msg
		}
		return fmt.Sprintf("%s: %s", e.Code, msg)
	}
	if e.Code == "" {
		return fmt.Sprintf("%s: %s", e.Op, msg)
	}
	return fmt.Sprintf("%s %s: %s", e.Code, e.Op, msg)
}

// Unwrap returns the wrapped lower-level error, when present.
func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func sdkError(code, op, message string, err error) error {
	return &Error{Code: code, Op: op, Message: message, Err: err}
}

func wrapError(code, op string, err error) error {
	if err == nil {
		return nil
	}
	var sdkErr *Error
	if errors.As(err, &sdkErr) {
		return err
	}
	return sdkError(code, op, "", err)
}
