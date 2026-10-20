# The static mirror: nginx serving the crawled pages and downloads in ./site (see docs/deploy.md, "Static mirror").
ARG NGINX_IMAGE=nginx:1.27-alpine
FROM ${NGINX_IMAGE}
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/mirror.conf
COPY site /usr/share/nginx/html
COPY 404.html /usr/share/nginx/html/404.html
