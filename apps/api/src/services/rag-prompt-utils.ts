/**
 * Softens strict "KB ONLY" instructions in the agent's main system prompt
 * when allow_related_general_answers is enabled.
 */
export function relaxAgentPrompt(prompt: string, allowRelated: boolean): string {
  if (!allowRelated) return prompt;
  return prompt
    .replace(/Answer from (the )?given knowledgebase only/gi, "Answer primarily from the given knowledgebase")
    .replace(/Answer using ONLY information from (the )?KNOWLEDGEBASE/gi, "Answer primarily using information from the KNOWLEDGEBASE")
    .replace(/only if you don't have answer in knowledgebase/gi, "if you don't have a specific answer in the knowledgebase")
    .replace(/only use information from (the )?provided context/gi, "primarily use information from the provided context")
    .replace(/strictly use the knowledgebase/gi, "primarily use the knowledgebase")
    .replace(/answer from given knowledgebase/gi, "answer primarily from given knowledgebase")
    .replace(/don't have answer in knowledgebase/gi, "don't have a specific answer in the knowledgebase")
    .replace(/only if you don't have answer/gi, "if you don't have a specific answer");
}
