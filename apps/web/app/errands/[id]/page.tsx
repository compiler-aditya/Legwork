import MissionControl from './MissionControl';

export default async function ErrandPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MissionControl id={id} />;
}
