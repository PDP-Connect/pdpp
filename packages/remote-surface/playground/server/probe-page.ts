export function renderProbePage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Remote surface probe</title>
    <style>
      :root {
        color-scheme: light;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: oklch(0.98 0.006 218);
        color: oklch(0.22 0.018 230);
      }

      * {
        box-sizing: border-box;
      }

      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        padding: 28px;
      }

      main {
        width: min(100%, 460px);
        display: grid;
        gap: 18px;
      }

      h1 {
        margin: 0;
        font-size: 28px;
        line-height: 1.05;
        letter-spacing: 0;
      }

      p {
        margin: 0;
        color: oklch(0.43 0.022 232);
        line-height: 1.45;
      }

      form {
        display: grid;
        gap: 14px;
        padding: 18px;
        border: 1px solid oklch(0.84 0.018 228);
        border-radius: 8px;
        background: oklch(0.995 0.004 218);
      }

      label {
        display: grid;
        gap: 6px;
        font-size: 13px;
        font-weight: 650;
      }

      input {
        min-height: 48px;
        border: 1px solid oklch(0.76 0.024 228);
        border-radius: 6px;
        padding: 0 12px;
        font-size: 16px;
        background: oklch(1 0.003 218);
        color: oklch(0.2 0.018 230);
      }

      input:focus {
        outline: 2px solid oklch(0.62 0.15 238);
        outline-offset: 2px;
      }

      button {
        min-height: 48px;
        border: 0;
        border-radius: 6px;
        background: oklch(0.35 0.12 238);
        color: oklch(0.98 0.01 238);
        font-weight: 720;
        font-size: 15px;
      }

      #effect {
        min-height: 38px;
        border-radius: 6px;
        padding: 10px 12px;
        background: oklch(0.93 0.036 165);
        color: oklch(0.25 0.062 165);
        font-size: 13px;
      }

      #effect::after {
        content: "";
        display: inline-block;
        width: 5px;
        height: 5px;
        margin-left: 8px;
        border-radius: 50%;
        background: currentColor;
        animation: pulse 900ms ease-in-out infinite alternate;
      }

      @keyframes pulse {
        from {
          opacity: 0.2;
        }
        to {
          opacity: 1;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>Remote login probe</h1>
        <p>Use the harness to tap fields, type values, backspace, and submit.</p>
      </header>
      <form id="login-form" autocomplete="off">
        <label>
          Email
          <input id="email" name="email" type="email" inputmode="email" autocomplete="username" />
        </label>
        <label>
          Password
          <input id="password" name="password" type="password" autocomplete="current-password" />
        </label>
        <label>
          2FA code
          <input id="otp" name="otp" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" />
        </label>
        <button id="submit" type="submit">Continue</button>
      </form>
      <div id="effect" aria-live="polite">No submitted value yet.</div>
    </main>
    <script>
      (() => {
        const eventLog = [];
        let clickCount = 0;
        let lastClick = null;
        let submitCount = 0;
        const form = document.getElementById("login-form");
        const effect = document.getElementById("effect");

        const describeTarget = (target) => {
          if (!(target instanceof HTMLElement)) return { id: "", tag: "" };
          return {
            id: target.id || "",
            tag: target.tagName,
            type: target instanceof HTMLInputElement ? target.type : "",
            value: target instanceof HTMLInputElement ? target.value : "",
          };
        };

        const describeRect = (id) => {
          const target = document.getElementById(id);
          if (!(target instanceof HTMLElement)) return null;
          const rect = target.getBoundingClientRect();
          return {
            height: rect.height,
            left: rect.left,
            top: rect.top,
            width: rect.width,
          };
        };

        const push = (type, event) => {
          const entry = {
            type,
            time: Date.now(),
            key: "key" in event ? event.key : "",
            inputType: "inputType" in event ? event.inputType : "",
            data: "data" in event ? event.data : "",
            target: describeTarget(event.target),
          };
          eventLog.push(entry);
          while (eventLog.length > 80) eventLog.shift();
        };

        for (const type of ["focusin", "keydown", "keyup", "beforeinput", "input", "change"]) {
          document.addEventListener(type, (event) => push(type, event), true);
        }

        document.addEventListener("click", (event) => {
          clickCount += 1;
          lastClick = {
            x: event.clientX,
            y: event.clientY,
            target: describeTarget(event.target),
            time: Date.now(),
          };
          push("click", event);
        }, true);

        form.addEventListener("submit", (event) => {
          event.preventDefault();
          submitCount += 1;
          effect.textContent = "Submitted " + document.getElementById("email").value + " / "
            + document.getElementById("otp").value + " (#" + submitCount + ")";
        });

        window.__remoteSurfaceProbe = {
          snapshot() {
            const active = document.activeElement;
            return {
              active: describeTarget(active),
              values: {
                email: document.getElementById("email").value,
                password: document.getElementById("password").value,
                otp: document.getElementById("otp").value,
              },
              eventLog: eventLog.slice(-20),
              clickCount,
              lastClick,
              targetRects: {
                email: describeRect("email"),
                password: describeRect("password"),
                otp: describeRect("otp"),
                submit: describeRect("submit"),
              },
              submitCount,
              effect: effect.textContent,
              viewport: {
                width: window.innerWidth,
                height: window.innerHeight,
                visualWidth: window.visualViewport ? Math.round(window.visualViewport.width) : window.innerWidth,
                visualHeight: window.visualViewport ? Math.round(window.visualViewport.height) : window.innerHeight,
                devicePixelRatio: window.devicePixelRatio,
              },
            };
          },
          clear() {
            eventLog.length = 0;
            clickCount = 0;
            lastClick = null;
            submitCount = 0;
            for (const id of ["email", "password", "otp"]) {
              document.getElementById(id).value = "";
            }
            effect.textContent = "No submitted value yet.";
          }
        };
      })();
    </script>
  </body>
</html>`;
}
