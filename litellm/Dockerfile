FROM ghcr.io/berriai/litellm:main-latest

COPY config.yaml /app/config.yaml
COPY custom_callbacks/ /app/custom_callbacks/

EXPOSE 4000

CMD ["--config", "/app/config.yaml", "--port", "4000"]
