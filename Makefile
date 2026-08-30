.PHONY: up down logs seed test build backup guild-create

up:
	docker compose up --build

down:
	docker compose down

logs:
	docker compose logs -f

seed:
	docker compose run --rm migrate sh -c "pnpm --filter @glps/api exec tsx src/db/seed.ts"

test:
	pnpm -r run test

build:
	pnpm -r run build

# make backup -> ./backups/glps-<timestamp>.sql (§13)
backup:
	mkdir -p backups
	docker compose exec -T db pg_dump -U $${POSTGRES_USER:-glps} $${POSTGRES_DB:-glps} > backups/glps-$$(date +%Y%m%d-%H%M%S).sql
	@echo "Restore with: docker compose exec -T db psql -U \$$POSTGRES_USER -d \$$POSTGRES_DB < backups/<file>.sql"

# make guild:create SLUG=nightfall NAME="Nightfall" (§3A.7)
guild-create:
	@test -n "$(SLUG)" || (echo "usage: make guild-create SLUG=<slug> NAME=\"<name>\"" && exit 1)
	docker compose run --rm api node dist/scripts/guild-create.js --slug "$(SLUG)" --name "$(NAME)"
