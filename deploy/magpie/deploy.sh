#!/bin/sh
# Put magpie in Docker on a server, with the Qoder sign-ins this machine
# already has.
#
#   ./deploy.sh                      # build ./config here
#   ./deploy.sh --host 192.168.0.60  # and say what other machines call it
#   ./deploy.sh --lan                # publish the ports, not just loopback
#
# Run from the repo root, where tools/sync-magpie.mjs lives.
set -eu

host=""
lan=0
while [ $# -gt 0 ]; do
  case "$1" in
    --lan) lan=1 ;;
    --host) host="${2:-}"; shift ;;
    --host=*) host="${1#*=}" ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
site="$here"

# setenv writes one KEY=value into .env, replacing or appending it, with awk
# alone: sed -i differs between GNU and BSD.
setenv() {
  key="$1" val="$2"
  awk -v k="$key" -v v="$val" '
    BEGIN { done = 0 }
    $0 ~ "^" k "=" { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$site/.env" > "$site/.env.new"
  mv "$site/.env.new" "$site/.env"
}

if [ ! -f "$site/.env" ]; then
  cp "$site/.env.example" "$site/.env"
  setenv MAGPIE_WEB_KEY "$(openssl rand -hex 16)"
  echo "made $site/.env"
fi

# A desktop magpie on this machine already holds 3425; give the container its
# own host port rather than fight it for the same one.
port_used() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
want=$(grep '^MAGPIE_PORT=' "$site/.env" | cut -d= -f2)
: "${want:=3425}"
if port_used "$want"; then
  try=3426
  while port_used "$try"; do try=$((try + 1)); done
  echo "host port $want is taken here (a desktop magpie?), so the container takes $try"
  setenv MAGPIE_PORT "$try"
  want="$try"
fi
if [ -n "$host" ]; then setenv MAGPIE_PUBLIC_URL "http://$host:$want"; fi

if [ "$lan" = 1 ]; then
  # publish on every interface instead of loopback only
  perl -0pi -e 's/"127\.0\.0\.1:(\d+):/$1:/g' "$site/docker-compose.yml" 2>/dev/null || \
    sed -i 's|"127.0.0.1:|"|g' "$site/docker-compose.yml"
  echo "ports now published on all interfaces"
fi

echo
echo "syncing the Qoder sign-ins magpie has here"
node "$root/tools/sync-magpie.mjs" --to "$site/config"

# The image runs as nonroot 65532 and must own everything it reads. Its own
# root does the chown, so no sudo is needed: the runner only needs to be in
# the docker group.
echo
docker run --rm --user 0 -v "$site/config:/config" --entrypoint sh \
  "$(sed -n 's/^ *image: *//p' "$site/docker-compose.yml" | head -1)" \
  -c 'chown -R 65532:65532 /config && chmod 700 /config && chmod 600 /config/magpie/*.json' \
  || echo "could not set /config's owner; if magpie reports it cannot write, run that chown yourself"

cd "$site"
docker compose --env-file .env up -d
sleep 6
docker compose ps
echo
echo "the page:  docker compose logs magpie | head -3   (the link carries the key)"
echo "the gateway: $(grep '^MAGPIE_PUBLIC_URL=' .env | cut -d= -f2-)/v1"
echo
echo "a key for a client:  docker compose exec magpie magpie gateway-key add \"laptop\""
