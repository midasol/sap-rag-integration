import { PipelineDashboard } from '@/components/PipelineDashboard';
import Link from 'next/link';

export default function PipelinePage() {
  return (
    <div>
      <div className="border-b px-6 py-3 flex items-center justify-between">
        <span className="font-semibold">Admin: Pipeline Management</span>
        <Link href="/chat" className="text-sm text-muted-foreground hover:underline">
          &larr; Back to Chat
        </Link>
      </div>
      <PipelineDashboard />
    </div>
  );
}
