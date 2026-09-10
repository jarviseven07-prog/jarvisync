import './node-number.css';

export function NodeNumber({ value }: { value: string }) {
  if (!value) return null;
  return <span className="node-number" title={`节点编号 #${value}`}>#{value}</span>;
}
