ARG NEKO_BASE_IMAGE=ghcr.io/m1k1o/neko/chromium:3.0@sha256:13264ee217ecccda06b07aa7543dc12d8f9a423ace344b6bda6ebf6d2ecea193
FROM ${NEKO_BASE_IMAGE}

COPY docker/neko/xorg.conf /etc/neko/xorg.conf
COPY docker/neko/neko.yaml /etc/neko/neko.yaml
COPY docker/neko/policies.json /etc/chromium/policies/managed/policies.json
COPY docker/neko/chromium.conf /etc/neko/supervisord/chromium.conf
COPY docker/neko/cdp-proxy.conf /etc/neko/supervisord/cdp-proxy.conf
COPY docker/neko/start-chromium.sh /usr/local/bin/start-chromium.sh
COPY docker/neko/start-neko.sh /usr/local/bin/start-neko.sh
COPY docker/neko/cdp-proxy.py /usr/local/bin/cdp-proxy.py

RUN chmod +x /usr/local/bin/start-chromium.sh /usr/local/bin/start-neko.sh /usr/local/bin/cdp-proxy.py \
  && sed -i 's#command=/usr/bin/neko serve --server.static "/var/www"#command=/usr/local/bin/start-neko.sh#' /etc/neko/supervisord.conf \
  && sed -i '/<applications>/a\    <application class="RemoteBrowserApp">\
      <decor>no</decor>\
      <position force="yes">\
        <x>0</x>\
        <y>0</y>\
      </position>\
      <focus>yes</focus>\
      <layer>normal</layer>\
    </application>\
' /etc/neko/openbox.xml \
  && printf '#!/bin/sh\nrm -f /tmp/.X99-lock /tmp/.X11-unix/X99 /tmp/xf86-input-neko.sock\nrm -f /home/user/.config/chromium/SingletonLock /home/user/.config/chromium/SingletonSocket /home/user/.config/chromium/SingletonCookie\nexec "$@"\n' > /usr/local/bin/pdpp-neko-entrypoint.sh \
  && chmod +x /usr/local/bin/pdpp-neko-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/pdpp-neko-entrypoint.sh"]
CMD ["/usr/bin/supervisord", "-c", "/etc/neko/supervisord.conf"]
