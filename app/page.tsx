import { redirect } from 'next/navigation';

// Stories are picked and drafted straight from the Sources page, so the old
// combined workspace at / now points there.
export default function Home() {
  redirect('/sources');
}
