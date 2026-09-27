// Next 서버가 뜰 때 이벤트 워커를 함께 시작한다. NOW_WORKER=off 이면 끈다 (별도 `npm run worker` 사용 시).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NOW_WORKER === "off") return;
  const [{ startWorker }, { db }] = await Promise.all([import("./lib/events/worker"), import("./lib/db")]);
  startWorker(db);
}
