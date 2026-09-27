// 온라인 백업: npm run db:backup  (콘솔 /system 의 '지금 백업' 과 같은 액션)
import { db } from "@/lib/db";
import { executeAction } from "@/lib/ontology/execute";
import { SYSTEM } from "@/lib/ontology/types";

const r = executeAction(db(), { actor: SYSTEM, action: "system.backup", params: {}, reason: "CLI" });
console.log(r.status === "applied" ? `백업 완료 → ${r.result?.summary}` : `백업 실패: ${r.error}`);
process.exit(r.status === "applied" ? 0 : 1);
