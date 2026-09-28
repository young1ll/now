// 임베딩 공간 액션 — 의미 검색 설정. 전부 사람 전용.
// 외부 공급자(본문이 기기를 떠남)로 만들거나 전환하는 것은 high: 사업 데이터가 밖으로 나가는 결정이다.
import { EMBED_PROVIDER_INFO, defaultBaseUrl, isLocalSpace } from "@/lib/knowledge/embed";
import { attachVectors, spaceCoverage, vectorStoreInfo, vectorsEnabled } from "@/lib/knowledge/vectors";
import { EMBED_PROVIDERS, activeSpace, getSpace, insertSpace, setSpaceStatus } from "@/lib/repos/embeddings";
import { defineAction } from "../action";
import { f } from "../fields";
import { ActionError } from "../types";
import { must } from "./util";

const PROVIDER_LABELS = Object.fromEntries(EMBED_PROVIDERS.map((p) => [p, EMBED_PROVIDER_INFO[p].label])) as Record<(typeof EMBED_PROVIDERS)[number], string>;

/** 폼 입력은 앞뒤 공백이 잘린다 — "query:" 처럼 콜론으로 끝나는 접두사는 관례대로 공백 한 칸을 붙인다 */
const prefix = (v: unknown) => {
  const s = String(v ?? "");
  return /:$/.test(s) ? `${s} ` : s;
};

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export const embeddingActions = [
  defineAction({
    name: "embedding.space_create",
    title: "임베딩 공간 추가",
    description:
      "의미(벡터) 검색에 쓸 임베딩 공급자·모델을 등록한다. 워커가 뒤에서 모든 청크를 임베딩해 채우고, 다 차면 활성화할 수 있다. 로컬(Ollama·사설망)이 아니면 사업 데이터 본문이 외부로 전송된다.",
    objectType: "system",
    risk: (_db, i) => (isLocalSpace(i.provider, i.base_url ?? "") ? "low" : "high"),
    humanOnly: true,
    fields: {
      name: f.text("이름", { required: true, placeholder: "로컬 bge-m3 (Ollama)" }),
      provider: f.enum("공급자", EMBED_PROVIDERS, PROVIDER_LABELS, { required: true }),
      model: f.text("모델", { required: true, placeholder: "bge-m3", help: "Ollama: bge-m3 · OpenAI: text-embedding-3-small · Gemini: gemini-embedding-001 · Voyage: voyage-3.5" }),
      base_url: f.text("Base URL", { max: 300, help: "비우면 공급자 기본값 (Ollama: http://127.0.0.1:11434). localhost·사설망 주소면 로컬로 본다" }),
      api_key_env: f.text("API 키 환경변수 이름", { help: "비우면 공급자 기본 (OPENAI_API_KEY · GEMINI_API_KEY · VOYAGE_API_KEY). 값은 .env.local 에만" }),
      query_prefix: f.text("질의 접두사", { max: 100, help: 'e5 계열: "query:" (콜론으로 끝나면 공백 한 칸이 붙는다)' }),
      passage_prefix: f.text("문서 접두사", { max: 100, help: 'e5 계열: "passage:"' }),
      auto_activate: f.boolean("다 채워지면 자동 활성화", { help: "활성 공간이 없을 때만" }),
    },
    preview: (_db, i) => `임베딩 공간 '${i.name}' (${EMBED_PROVIDER_INFO[i.provider].label} · ${i.model}) 추가`,
    run({ db }, i) {
      const baseUrl = (i.base_url ?? "").trim();
      if (baseUrl && !/^https?:\/\/[^\s/]+/.test(baseUrl)) throw new ActionError("Base URL 은 http(s):// 로 시작하는 주소여야 합니다");
      const keyEnv = (i.api_key_env ?? "").trim();
      if (keyEnv && !/^[A-Z][A-Z0-9_]*$/.test(keyEnv)) throw new ActionError("API 키에는 값이 아니라 환경변수 이름만 입력하세요 (예: OPENAI_API_KEY)");
      if (i.provider === "openai_compatible" && !baseUrl) throw new ActionError("OpenAI 호환 공급자는 Base URL 이 필요합니다 (예: http://127.0.0.1:1234/v1)");
      const local = isLocalSpace(i.provider, baseUrl);
      const id = insertSpace(db, {
        name: i.name,
        provider: i.provider,
        model: i.model.trim(),
        base_url: baseUrl,
        api_key_env: keyEnv,
        query_prefix: prefix(i.query_prefix),
        passage_prefix: prefix(i.passage_prefix),
        local_only: local,
        auto_activate: !!i.auto_activate,
      });
      const where = local ? "로컬 — 본문이 이 기기/사설망을 떠나지 않음" : `외부 전송 — 사업 데이터 본문이 ${hostOf(baseUrl || defaultBaseUrl(i.provider))} 로 나감`;
      return {
        summary: `임베딩 공간 '${i.name}' (${EMBED_PROVIDER_INFO[i.provider].label} · ${i.model}) 추가 · ${where}${i.auto_activate ? " · 다 차면 자동 활성화" : ""}`,
        refs: [],
        data: { space_id: id, local_only: local },
      };
    },
  }),
  defineAction({
    name: "embedding.activate",
    title: "임베딩 공간 활성화",
    description: "채워진(building) 임베딩 공간을 검색에 쓰도록 전환한다. 기존 활성 공간은 폐기(retired)되고 그 벡터는 다음 정리 때 삭제된다. 외부 공급자면 이후 검색 질의가 외부로 전송된다.",
    objectType: "system",
    risk: (db, i) => (getSpace(db, i.id)?.local_only === 0 ? "high" : "low"),
    humanOnly: true,
    // ATTACH(벡터 저장소 열기)는 트랜잭션 안에서 할 수 없다 — 먼저 붙이고 상태 변경만 트랜잭션으로
    noTransaction: true,
    fields: {
      id: f.number("공간 id", { required: true, int: true, min: 1 }),
      force: f.boolean("강제 (100% 가 아니어도)", { help: "덜 찬 공간으로 전환하면 아직 임베딩되지 않은 객체는 의미 검색에 안 나온다" }),
    },
    preview: (db, i) => `임베딩 공간 '${getSpace(db, i.id)?.name ?? i.id}' 활성화`,
    run({ db }, i) {
      const s = must(getSpace(db, i.id), "임베딩 공간");
      if (s.status !== "building") throw new ActionError(`채우는 중(building)인 공간만 활성화할 수 있습니다 — 현재 ${s.status}`);
      if (!vectorsEnabled()) throw new ActionError("벡터 기능이 꺼져 있습니다 (NOW_VECTORS=off)");
      if (!attachVectors(db)) throw new ActionError(vectorStoreInfo(db).error ?? "벡터 저장소를 열 수 없습니다");
      if (s.dim === 0) throw new ActionError("아직 한 번도 임베딩하지 못했습니다 (차원 미정) — 공급자 연결을 확인하세요");
      const cov = spaceCoverage(db, s.id);
      if (cov.pct < 100 && !i.force) throw new ActionError(`아직 ${cov.pct}% (${cov.embedded}/${cov.total}) — force 로 강제 가능`);
      const prev = activeSpace(db);
      db.transaction(() => {
        for (const p of db.prepare("SELECT id FROM embedding_spaces WHERE status = 'active'").all() as { id: number }[]) setSpaceStatus(db, p.id, "retired");
        setSpaceStatus(db, s.id, "active");
      })();
      return {
        summary: `임베딩 공간 '${s.name}' 활성화 (${cov.pct}%)${prev ? ` · 이전 '${prev.name}' 폐기` : ""}${s.local_only ? "" : " · 검색 질의가 외부로 전송됨"}`,
        refs: [],
        data: { space_id: s.id, coverage: cov.pct, retired: prev?.id ?? null },
      };
    },
  }),
  defineAction({
    name: "embedding.retire",
    title: "임베딩 공간 폐기",
    description: "임베딩 공간을 폐기한다. 벡터는 다음 정리(시간당) 때 삭제된다. 활성 공간을 폐기하면 의미 검색이 꺼지고 어휘 + 관계 검색으로 동작한다.",
    objectType: "system",
    risk: "low",
    humanOnly: true,
    fields: { id: f.number("공간 id", { required: true, int: true, min: 1 }) },
    preview: (db, i) => `임베딩 공간 '${getSpace(db, i.id)?.name ?? i.id}' 폐기`,
    run({ db }, i) {
      const s = must(getSpace(db, i.id), "임베딩 공간");
      if (s.status === "retired") throw new ActionError("이미 폐기된 공간입니다");
      setSpaceStatus(db, s.id, "retired");
      return {
        summary:
          s.status === "active"
            ? `임베딩 공간 '${s.name}' 폐기 — 활성 공간이 없어 벡터(의미) 검색이 꺼지고 어휘 + 관계로 동작합니다`
            : `임베딩 공간 '${s.name}' 폐기 (채우던 벡터는 다음 정리 때 삭제)`,
        refs: [],
        data: { space_id: s.id, was: s.status },
      };
    },
  }),
];
