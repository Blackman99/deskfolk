/** A job and its tickets, by name: what a Bot's question about a job names them with. */
export type AttributionPlan = {
  id: string;
  title: string;
  tickets: { id: string; title: string }[];
};
