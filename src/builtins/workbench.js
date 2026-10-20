import { HttpError } from "../tasks.js";
import { UUID } from "../history.js";
export function workbenchPlugin({ tasks, history, refresh, streams }) {
  return {
    id: "workbench",
    name: "任务工作台",
    description: "运行 Claude、跟踪输出和复用任务",
    icon: "⌘",
    order: 10,
    type: "native",
    aliases: ["/api/tasks"],
    async handle({
      req,
      res,
      url,
      route: local,
      legacy,
      body,
      json,
      isAuthorized,
    }) {
      const route = legacy ? local : "/api" + local;
      const respond = (status, value) => {
        json(res, status, value);
        return true;
      };
      if (route === "/api/tasks" && req.method === "GET")
        return respond(200, { tasks: tasks.list() });
      if (route === "/api/tasks" && req.method === "POST") {
        const input = await body(req);
        if (input?.resumeId) {
          if (typeof input.resumeId !== "string" || !UUID.test(input.resumeId))
            throw new HttpError(400, "会话 ID 无效");
          await refresh();
          const session = history.index.get(input.resumeId);
          if (!session) throw new HttpError(404, "会话不存在");
          input.cwd = session.cwd; // Claude resumes in the original project directory.
        }
        const item = await tasks.start(input);
        return respond(201, { id: item.id });
      }
      const match = /^\/api\/tasks\/([a-f0-9-]+)(?:\/(events|stop))?$/.exec(
        route,
      );
      if (match && UUID.test(match[1])) {
        const id = match[1],
          action = match[2];
        if (!tasks.items.has(id)) throw new HttpError(404, "任务不存在");
        if (action === "stop" && req.method === "POST")
          return respond(
            200,
            tasks.stop(id, (await body(req)).signal || "SIGINT"),
          );
        if (!action && req.method === "GET")
          return respond(200, await tasks.get(id));
        if (action === "events" && req.method === "GET") {
          const item = await tasks.get(id);
          if (streams.size >= 64) throw new HttpError(429, "流式连接过多");
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          let after = Number(
            req.headers["last-event-id"] || url.searchParams.get("after") || 0,
          );
          if (!Number.isSafeInteger(after) || after < 0) after = 0;
          const send = (event) => {
            if (event.seq <= after) return;
            after = event.seq;
            res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
            if (res.writableLength > 1_000_000) res.destroy();
          };
          const listener = (event) => {
            send(event);
            if (event.type === "status") res.end();
          };
          tasks.on(id, listener);
          streams.add(res);
          const timer = setInterval(() => {
            if (!isAuthorized()) res.end();
            else res.write(": heartbeat\n\n");
          }, 15000);
          res.on("close", () => {
            clearInterval(timer);
            tasks.off(id, listener);
            streams.delete(res);
          });
          for (const event of item.events) send(event);
          if (!["running", "stopping"].includes(item.status)) res.end();
          return true;
        }
      }

      return false;
    },
  };
}
