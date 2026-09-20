import type { Memory, StoragePort } from '../contracts.js';

/** Trusted host operation. Never exported as an agent tool or HTTP operation. */
export function reviewMemory(storage: StoragePort, projectId: string, id: string, decision: 'accepted' | 'rejected', by: string): Memory {
  if (!by.trim() || by.length > 100) throw new Error('A reviewer label (1–100 characters) is required.');
  return storage.atomic(() => {
    const memories = storage.memories(projectId);
    const memory = memories.find(m => m.id === id);
    if (!memory || !['proposed', 'needs_attention'].includes(memory.status)) throw new Error('Only pending candidates in this project can be reviewed.');
    if (decision === 'accepted' && memories.some(m => m.id !== id && m.key === memory.key && ['persist', 'accepted'].includes(m.status))) throw new Error('Active claim key conflicts. Review and explicitly forget the old memory first.');
    const reviewed: Memory = { ...memory, status: decision, reason: `Explicit local review by ${by}.`, review: { by, at: new Date().toISOString(), decision } };
    // Approval does not invent source evidence or promote content to source authority.
    storage.saveMemory(reviewed);
    return reviewed;
  });
}
