export const BUILTIN_SKILL_INSERT_SQL = `INSERT INTO skills (id, owner_id, name, description, instructions, source, category)
	 SELECT $1::bigint, 0, $2::varchar, $3::text, $4::text, $5::varchar, $6::varchar
	 WHERE NOT EXISTS (SELECT 1 FROM skills WHERE owner_id = 0 AND source = $5::varchar AND name = $2::varchar)`;
