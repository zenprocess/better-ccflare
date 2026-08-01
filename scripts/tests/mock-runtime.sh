#!/usr/bin/env bash
#
# mock-runtime.sh — configurable bash shim that impersonates docker|podman
# for the verify-live-build test harness. Behaviour is driven by
# `$MOCK_SCENARIO`. The shim is also the "podman" binary — same file,
# same scenarios. The script under test detects docker first; if
# docker's shim fails the operator-side runtime detection falls back
# to podman, which uses the same MOCK_SCENARIO.
#
# Scenarios:
#   no-runtime         Behaves like docker|podman missing. `info` exits 1.
#   no-container       `ps` is empty, `images` is empty.
#   all-match          Full happy path. Exact-name match, RepoDigest present,
#                      /health JSON agrees with OCI labels, /etc/ccflare-bun-
#                      revision yields the same bun commit, layers present.
#   drift              Same as all-match except /health.git_sha disagrees
#                      with OCI label org.opencontainers.image.revision.
#   health-down        /health exec returns HTTP 500-equivalent. All else OK.
#   pre-109-image      /health succeeds but lacks the four provenance fields.
#   multi-match        `ps` returns two containers both matching "ccflare".

set -u

SCEN="${MOCK_SCENARIO:-help}"

# Format a "row" the way the mock's strategy C table uses:
#   ID (no whitespace) | Names (no whitespace) | Image (no whitespace)
#
# Strategy A/B return TWO fields (ID + Names) when the script asks for
# --format '{{.ID}} {{.Names}}'. Strategy C returns THREE.

row3() {
	# $1=id  $2=name  $3=image
	printf '%s %s %s\n' "$1" "$2" "$3"
}

row2() {
	# $1=id  $2=name
	printf '%s %s\n' "$1" "$2"
}

list_ambig() {
	row3 abc111 ccflare-1 ccflare:1.0.0
	row3 abc222 ccflare-2 ccflare:1.0.0
}

if [ "$SCEN" = "no-runtime" ]; then
	echo "mock-runtime: not configured (scenario=no-runtime)" >&2
	exit 127
fi

case "$1" in
	info)
		exit 0
		;;
	version)
		echo "mock-runtime version 0.1 (scenario=$SCEN)"
		exit 0
		;;
	ps)
		shift
		FILTER_NAME=""
		FILTER_LABEL=""
		EMIT_FORMAT=""
		while [ $# -gt 0 ]; do
			case "$1" in
				--filter)
					shift
					case "$1" in
						name=*) FILTER_NAME="${1#name=}" ;;
						label=com.docker.compose.service=*)
							FILTER_LABEL="${1#label=com.docker.compose.service=}"
							;;
					esac
					shift
					;;
				--format) shift; EMIT_FORMAT="$1"; shift ;;
				*) shift ;;
			esac
		done

		case "$SCEN" in
			no-container)
				exit 0
				;;
			multi-match)
				# Strategy A's filter is exact name match. We refuse the
				# exact-name match (returning nothing) so the script
				# falls through to the substring fallback that lists
				# both candidates.
				if [ -n "$FILTER_NAME" ] && [ "$FILTER_NAME" = "^/ccflare\$" ]; then
					exit 0
				fi
				if [ -n "$FILTER_LABEL" ] && [ "$FILTER_LABEL" = "ccflare" ]; then
					exit 0
				fi
				# Strategy C passes through here.
				case "$EMIT_FORMAT" in
					*"{{.Image}}"*)
						list_ambig
						;;
					*)
						# Strategy A/B returning 2 fields — but we make the
						# names ambiguous (ccflare-1, ccflare-2). Each row
						# is unique. Listing two rows forces count>1 in the
						# script's resolve_container.
						row2 abc111 ccflare-1
						row2 abc222 ccflare-2
						;;
				esac
				exit 0
				;;
			all-match|drift|health-down|pre-109-image)
				if [ -n "$FILTER_NAME" ] && [ "$FILTER_NAME" = "^/ccflare\$" ]; then
					row2 abc123 ccflare
					exit 0
				fi
				if [ -n "$FILTER_LABEL" ] && [ "$FILTER_LABEL" = "ccflare" ]; then
					row2 abc123 ccflare
					exit 0
				fi
				case "$EMIT_FORMAT" in
					*"{{.Image}}"*)
						row3 abc123 ccflare ccflare:1.0.0
						;;
					*)
						row2 abc123 ccflare
						;;
				esac
				exit 0
				;;
			*)
				echo "mock-runtime: unknown scenario '$SCEN' in ps" >&2
				exit 1
				;;
		esac
		;;
	inspect)
		shift
		FMT=""
		TARGET=""
		while [ $# -gt 0 ]; do
			case "$1" in
				--format) shift; FMT="$1"; shift ;;
				*) TARGET="$1"; shift ;;
			esac
		done

		case "$FMT" in
			"{{.Config.Image}}")
				if [ "$SCEN" = "no-container" ]; then
					echo ""
					exit 1
				fi
				printf 'ccflare:1.0.0\n'
				exit 0
				;;
			"{{(index (index .HostConfig.PortBindings \"8080/tcp\") 0).HostPort}}")
				printf '8081\n'
				exit 0
				;;
			"{{index .RepoDigests 0}}")
				printf 'ccflare@sha256:1111111111111111111111111111111111111111111111111111111111111111\n'
				exit 0
				;;
			"{{.Id}}")
				printf 'sha256:2222222222222222222222222222222222222222222222222222222222222222\n'
				exit 0
				;;
			"{{json .Config.Labels}}")
				case "$SCEN" in
					drift)
						# Deliberately disagree with /health.git_sha.
						printf '{"org.opencontainers.image.revision":"6c11fffffffffffffffffffffffffffffffffffff","org.opencontainers.image.version":"1.0.0","org.opencontainers.image.created":"2026-08-01T00:00:00Z","org.opencontainers.image.base.revision":"d00d000000000000000000000000000000000000","org.opencontainers.image.title":"ccflare"}\n'
						;;
					all-match|health-down|pre-109-image)
						printf '{"org.opencontainers.image.revision":"5aba000000000000000000000000000000000000000000","org.opencontainers.image.version":"1.0.0","org.opencontainers.image.created":"2026-08-01T00:00:00Z","org.opencontainers.image.base.revision":"d00d000000000000000000000000000000000000","org.opencontainers.image.title":"ccflare"}\n'
						;;
					*)
						printf 'null\n'
						;;
				esac
				exit 0
				;;
			"{{json .RootFS}}")
				case "$SCEN" in
					no-container)
						printf 'null\n'
						;;
					all-match|drift|health-down|pre-109-image|multi-match)
						printf '{"Layers":["sha256:layer1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sha256:layer2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","sha256:layer3cccccccccccccccccccccccccccccccccccccccccccccccccccccccc"]}\n'
						;;
				esac
				exit 0
				;;
			*)
				printf '\n'
				exit 0
				;;
		esac
		;;
	images)
		shift
		while [ $# -gt 0 ]; do
			case "$1" in
				--format) shift; shift ;;
				*) shift ;;
			esac
		done
		case "$SCEN" in
			all-match|drift|health-down|pre-109-image|multi-match)
				printf 'ccflare:1.0.0\n'
				;;
			no-container)
				: ;;
		esac
		exit 0
		;;
	exec)
		shift
		INNER="$*"

		case "$SCEN" in
			all-match|drift)
				case "$INNER" in
					*"command -v bun"*) exit 1 ;;
					*"cat /etc/ccflare-bun-revision"*)
						printf 'd00d000000000000000000000000000000000000\n'
						exit 0
						;;
					*"strings /app/ccflare-server"*)
						printf 'bun-node-d00d000000000000000000000000000000000000\n'
						exit 0
						;;
					*"curl"*"8080/health"*)
						# The grep -q in the script is also looking for
						# the *form* "curl ... http://127.0.0.1:8080/health".
						if [ "$SCEN" = "drift" ]; then
							printf '{"version":"1.0.0","git_sha":"5aba000000000000000000000000000000000000000000","git_ref":"1.0.0","build_date":"2026-08-01T00:00:00Z"}\n'
						else
							printf '{"version":"1.0.0","git_sha":"5aba000000000000000000000000000000000000000000","git_ref":"1.0.0","build_date":"2026-08-01T00:00:00Z"}\n'
						fi
						exit 0
						;;
				esac
				exit 0
				;;
			health-down)
				case "$INNER" in
					*"command -v bun"*) exit 1 ;;
					*"cat /etc/ccflare-bun-revision"*)
						printf 'd00d000000000000000000000000000000000000\n'
						exit 0
						;;
					*"curl"*"8080/health"*)
						printf 'internal server error\n'
						exit 22
						;;
				esac
				exit 0
				;;
			pre-109-image)
				case "$INNER" in
					*"command -v bun"*) exit 1 ;;
					*"cat /etc/ccflare-bun-revision"*)
						printf 'd00d000000000000000000000000000000000000\n'
						exit 0
						;;
					*"curl"*"8080/health"*)
						printf '{"status":"ok","uptime":42}\n'
						exit 0
						;;
				esac
				exit 0
				;;
			multi-match|no-container)
				exit 1
				;;
		esac
		;;
	*)
		echo "mock-runtime: unknown docker subcommand: $1" >&2
		exit 1
		;;
esac
