import { redirect } from 'next/navigation';

// The Story Queue moved to its own page (/queue) and Compose to /compose;
// the old combined workspace at / now points at the queue.
export default function Home() {
  redirect('/queue');
}
