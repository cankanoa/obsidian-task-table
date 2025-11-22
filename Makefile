# make version version=1.2.3

version:
	@if [ -z "$(version)" ]; then \
		echo "Usage: make version version=1.2.3"; \
		exit 1; \
	fi

	# Bump version, update manifest.json and versions.json,
	npm version $(version)

	# Push commit and tag
	git push
	git push --tags
