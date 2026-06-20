.PHONY: test test-go test-go-integration test-go-integration-sync test-go-integration-snapshot test-go-integration-runc test-go-integration-gvisor test-go-integration-docker test-go-integration-docker-runc test-go-integration-docker-gvisor test-go-integration-volumes test-go-integration-volumes-runc test-go-integration-volumes-gvisor test-go-integration-runtime-matrix test-python test-js build-js publish-python publish-js tidy-go verify-go-install

RUNC_POOL_ENV = $${BEAM_TEST_RUNC_POOL:+BEAM_TEST_POOL=$$BEAM_TEST_RUNC_POOL}
PYPI_REPOSITORY ?=
PYTHON_PUBLISH_ARGS = $(if $(PYPI_REPOSITORY),--repository $(PYPI_REPOSITORY),)
NPM_TAG ?= latest
NPM_PUBLISH_ARGS = $(if $(filter $(NPM_TAG),latest),,--tag $(NPM_TAG))

test: test-go test-python test-js

test-go:
	cd go && GOROOT= go test ./...

test-go-integration:
	cd go && GOROOT= BEAM_CLIENT_LOCAL_GATEWAY=1 BEAM_CLIENT_REQUIRE_LOCAL_GATEWAY=1 go test -tags=integration ./... -count=1

test-go-integration-sync:
	cd go && GOROOT= BEAM_CLIENT_LOCAL_GATEWAY=1 BEAM_CLIENT_REQUIRE_LOCAL_GATEWAY=1 go test -tags=integration ./... -run 'TestIntegration(FileSyncOnly|CreateSandboxWithSyncLocalDir)$$' -count=1 -v

test-go-integration-snapshot:
	cd go && GOROOT= BEAM_CLIENT_LOCAL_GATEWAY=1 BEAM_CLIENT_REQUIRE_LOCAL_GATEWAY=1 go test -tags=integration ./... -run TestIntegrationSandboxMemorySnapshot -count=1 -v

test-go-integration-runc:
	cd go && env GOROOT= BEAM_CLIENT_LOCAL_GATEWAY=1 BEAM_CLIENT_REQUIRE_LOCAL_GATEWAY=1 $(RUNC_POOL_ENV) go test -tags=integration ./... -count=1

test-go-integration-gvisor:
	cd go && GOROOT= BEAM_CLIENT_LOCAL_GATEWAY=1 BEAM_CLIENT_REQUIRE_LOCAL_GATEWAY=1 BEAM_TEST_POOL=$${BEAM_TEST_POOL:-gvisor} BEAM_TEST_DOCKER=1 go test -tags=integration ./... -count=1

test-go-integration-docker: test-go-integration-docker-runc test-go-integration-docker-gvisor

test-go-integration-docker-runc:
	cd go && env GOROOT= BEAM_CLIENT_LOCAL_GATEWAY=1 BEAM_CLIENT_REQUIRE_LOCAL_GATEWAY=1 $(RUNC_POOL_ENV) BEAM_TEST_DOCKER=1 go test -tags=integration ./... -run 'TestIntegrationDocker(Smoke|WorkspaceAndVolumeVisibility)$$' -count=1 -v

test-go-integration-docker-gvisor:
	cd go && GOROOT= BEAM_CLIENT_LOCAL_GATEWAY=1 BEAM_CLIENT_REQUIRE_LOCAL_GATEWAY=1 BEAM_TEST_POOL=$${BEAM_TEST_POOL:-gvisor} BEAM_TEST_DOCKER=1 go test -tags=integration ./... -run 'TestIntegrationDocker(Smoke|WorkspaceAndVolumeVisibility)$$' -count=1 -v

test-go-integration-volumes: test-go-integration-volumes-runc test-go-integration-volumes-gvisor

test-go-integration-volumes-runc:
	cd go && env GOROOT= BEAM_CLIENT_LOCAL_GATEWAY=1 BEAM_CLIENT_REQUIRE_LOCAL_GATEWAY=1 $(RUNC_POOL_ENV) go test -tags=integration ./... -run TestIntegrationVolumeMountPersistsAcrossSandboxes -count=1 -v

test-go-integration-volumes-gvisor:
	cd go && GOROOT= BEAM_CLIENT_LOCAL_GATEWAY=1 BEAM_CLIENT_REQUIRE_LOCAL_GATEWAY=1 BEAM_TEST_POOL=$${BEAM_TEST_POOL:-gvisor} go test -tags=integration ./... -run TestIntegrationVolumeMountPersistsAcrossSandboxes -count=1 -v

test-go-integration-runtime-matrix: test-go-integration-docker test-go-integration-volumes

test-python:
	cd python && poetry run pytest || test $$? -eq 5

test-js:
	cd js && npm ci && npm test

build-js:
	cd js && npm ci && npm run build

publish-python:
	cd python && poetry publish --build $(PYTHON_PUBLISH_ARGS)

publish-js:
	cd js && npm publish --access public $(NPM_PUBLISH_ARGS)

tidy-go:
	cd go && GOROOT= go mod tidy

verify-go-install:
	tmp=$$(mktemp -d); \
	trap 'rm -rf "$$tmp"' EXIT; \
	cd "$$tmp"; \
	GOROOT= go mod init example.com/beam-install-check; \
	GOROOT= go mod edit -replace github.com/beam-cloud/beam-client/go=$(CURDIR)/go; \
	GOROOT= go get github.com/beam-cloud/beam-client/go; \
	printf '%s\n' \
		'package main' \
		'' \
		'import beam "github.com/beam-cloud/beam-client/go"' \
		'' \
		'func main() {' \
		'	_ = beam.NewImage()' \
		'}' > main.go; \
	GOROOT= go test ./...
