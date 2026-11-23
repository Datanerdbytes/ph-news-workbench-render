import { redirect } from 'next/navigation';

// Stories are picked and drafted straight from the Sources page, so the old
// combined workspace at / now points there.
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (Array.isArray(value)) {
      for (const entry of value) params.append(key, entry);
    } else if (value !== undefined) {
      params.append(key, value);
    }
  }

  const query = params.toString();
  redirect(query ? `/sources?${query}` : '/sources');
}
