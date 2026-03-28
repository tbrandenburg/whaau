.PHONY: build up down test logs

build:
	docker compose --profile runner build runner
	docker compose build

up:
	docker compose up -d --build

down:
	docker compose down -v

test:
	bash test/e2e.sh

logs:
	docker compose logs -f
