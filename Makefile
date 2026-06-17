.PHONY: test test-go test-go-integration test-go-integration-runc test-go-integration-gvisor test-go-integration-docker test-python tidy-go

test: test-go test-python

test-go:
	cd go && GOROOT= go test ./...

test-go-integration:
	cd go && GOROOT= BEAM_CLIENT_LOCAL_GATEWAY=1 BEAM_CLIENT_REQUIRE_LOCAL_GATEWAY=1 go test -tags=integration ./...

test-go-integration-runc:
	cd go && GOROOT= BEAM_CLIENT_LOCAL_GATEWAY=1 BEAM_CLIENT_REQUIRE_LOCAL_GATEWAY=1 go test -tags=integration ./...

test-go-integration-gvisor:
	cd go && GOROOT= BEAM_CLIENT_LOCAL_GATEWAY=1 BEAM_CLIENT_REQUIRE_LOCAL_GATEWAY=1 BEAM_TEST_POOL=$${BEAM_TEST_POOL:-gvisor} BEAM_TEST_DOCKER=1 go test -tags=integration ./...

test-go-integration-docker:
	cd go && GOROOT= BEAM_CLIENT_LOCAL_GATEWAY=1 BEAM_CLIENT_REQUIRE_LOCAL_GATEWAY=1 BEAM_TEST_POOL=$${BEAM_TEST_POOL:-gvisor} BEAM_TEST_DOCKER=1 go test -tags=integration ./... -run TestIntegrationDockerSmoke -count=1 -v

test-python:
	cd python && poetry run pytest

tidy-go:
	cd go && GOROOT= go mod tidy
