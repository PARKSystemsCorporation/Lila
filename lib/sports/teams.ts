import { PoolClient } from 'pg'

function slugChunk(text: string, len = 3): string {
  const ascii = text.toLowerCase().replace(/[^a-z]/g, '')
  return ascii.slice(0, len).padEnd(len, 'x')
}

function fourDigitRand(): string {
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0')
}

export function buildTeamId(city: string, name: string): string {
  return `${slugChunk(city)}${slugChunk(name)}${fourDigitRand()}`
}

export async function getOrCreateTeamId(
  client: PoolClient,
  args: { city: string; name: string; league: string },
): Promise<string> {
  const { city, name, league } = args

  const existing = await client.query<{ team_id: string }>(
    `SELECT team_id FROM sports_teams
       WHERE league = $1 AND city = $2 AND name = $3
       LIMIT 1`,
    [league, city, name],
  )
  if (existing.rows[0]) return existing.rows[0].team_id

  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = buildTeamId(city, name)
    const inserted = await client.query<{ team_id: string }>(
      `INSERT INTO sports_teams (team_id, city, name, league)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (league, city, name) DO NOTHING
         RETURNING team_id`,
      [candidate, city, name, league],
    )
    if (inserted.rows[0]) return inserted.rows[0].team_id

    const race = await client.query<{ team_id: string }>(
      `SELECT team_id FROM sports_teams
         WHERE league = $1 AND city = $2 AND name = $3
         LIMIT 1`,
      [league, city, name],
    )
    if (race.rows[0]) return race.rows[0].team_id
  }

  throw new Error(`team-id collision for ${league}/${city}/${name}`)
}
