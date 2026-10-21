/** SERIES 78ab23f asset_dsl.go: parameterized AND/OR asset queries. */
const strings: Record<string, string> = Object.fromEntries(
	"domain root_domain ip url page_title icp service_name app_name bundle_id category app_icp method service_type record_type"
		.split(" ")
		.map((k) => [k, k]),
);
strings.title = "page_title";
const numbers: Record<string, string> = {
	port: "port",
	status: "status_code",
	status_code: "status_code",
};
const arrays: Record<string, string> = {
	technology: "technologies",
	technologies: "technologies",
	tech: "technologies",
};
export class AssetQueryError extends Error {
	statusCode = 400;
}
type Token = { kind: string; field?: string; op?: string; value?: string };
export function compileAssetDSL(
	input: string,
	values: unknown[],
	alias = "a",
): string {
	if (!input.trim()) return "TRUE";
	const tokens: Token[] = [];
	let i = 0;
	const word = () => {
		if (input[i] === '"') {
			const start = ++i;
			while (i < input.length && input[i] !== '"') i++;
			if (i === input.length) throw new AssetQueryError("DSL 缺少结束引号");
			return input.slice(start, i++);
		}
		const start = i;
		while (i < input.length && !/[\s()]/u.test(input[i]!)) i++;
		return input.slice(start, i);
	};
	while (i < input.length) {
		if (/\s/u.test(input[i]!)) {
			i++;
			continue;
		}
		if ("()".includes(input[i]!)) {
			tokens.push({ kind: input[i++]! });
			continue;
		}
		const m = /^([a-zA-Z_]\w*)(==|!=|>=|<=|=|>|<)/.exec(input.slice(i));
		if (m) {
			i += m[0].length;
			const value = word();
			if (!value) throw new AssetQueryError("DSL 表达式缺少值");
			tokens.push({
				kind: "value",
				field: m[1]!.toLowerCase(),
				op: m[2],
				value,
			});
		} else {
			const value = word();
			tokens.push({
				kind: /^(AND|OR)$/i.test(value) ? value.toUpperCase() : "value",
				value,
			});
		}
	}
	let p = 0;
	const param = (v: unknown) => {
		values.push(v);
		return `$${values.length}`;
	};
	const integer = (v: string) => {
		if (!/^-?\d+$/.test(v) || !Number.isSafeInteger(Number(v)))
			throw new AssetQueryError("DSL 数值字段需要整数");
		return Number(v);
	};
	const leaf = (t: Token) => {
		const f = t.field ?? "",
			op = t.op ?? "=",
			v = t.value ?? "";
		if (!f) {
			const q = param(`%${v}%`);
			return (
				"(" +
				[
					"domain",
					"root_domain",
					"ip",
					"url",
					"page_title",
					"icp",
					"service_name",
					"app_name",
					"app_description",
				]
					.map((c) => `${alias}.${c} ILIKE ${q}`)
					.concat(
						["technologies", "bound_domains"].map(
							(c) =>
								`EXISTS(SELECT 1 FROM unnest(${alias}.${c}) v WHERE v ILIKE ${q})`,
						),
					)
					.join(" OR ") +
				")"
			);
		}
		if (f === "task_id") return `${param(integer(v))}=ANY(${alias}.task_ids)`;
		if (f === "company_id") return `${alias}.company_id=${param(integer(v))}`;
		if (numbers[f])
			return `${alias}.${numbers[f]} ${op === "==" ? "=" : op} ${param(integer(v))}`;
		if (arrays[f]) {
			const col = `${alias}.${arrays[f]}`;
			if (op === "=")
				return `EXISTS(SELECT 1 FROM unnest(${col}) v WHERE v ILIKE ${param("%" + v + "%")})`;
			if (op === "==" || op === "!=")
				return `${op === "!=" ? "NOT " : ""}(${param(v)}=ANY(${col}))`;
			throw new AssetQueryError(`数组字段 ${f} 不支持 ${op}`);
		}
		if (strings[f]) {
			if (!["=", "==", "!="].includes(op))
				throw new AssetQueryError(`字符串字段 ${f} 不支持 ${op}`);
			return `${alias}.${strings[f]} ${op === "==" ? "=" : op === "!=" ? "NOT ILIKE" : "ILIKE"} ${param(op === "==" ? v : "%" + v + "%")}`;
		}
		throw new AssetQueryError(`未知 DSL 字段: ${f}`);
	};
	const atom = (): string => {
		const t = tokens[p++];
		if (t?.kind === "(") {
			const q = or();
			if (tokens[p++]?.kind !== ")")
				throw new AssetQueryError("DSL 缺少右括号");
			return `(${q})`;
		}
		if (t?.kind === "value") return leaf(t);
		throw new AssetQueryError("DSL 表达式不完整");
	};
	const and = (): string => {
		let q = atom();
		while (tokens[p]?.kind === "AND") {
			p++;
			q = `(${q}) AND (${atom()})`;
		}
		return q;
	};
	const or = (): string => {
		let q = and();
		while (tokens[p]?.kind === "OR") {
			p++;
			q = `(${q}) OR (${and()})`;
		}
		return q;
	};
	const sql = or();
	if (p !== tokens.length)
		throw new AssetQueryError("DSL 存在多余内容；条件之间请使用 AND/OR");
	return sql;
}
