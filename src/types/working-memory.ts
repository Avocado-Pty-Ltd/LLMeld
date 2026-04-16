export interface ActiveFile {
  path: string;
  purpose: string;
  last_action: 'read' | 'modified' | 'created';
}

export interface KeyDecision {
  decision: string;
  rationale?: string;
}

export interface ErrorContext {
  description: string;
  attempted_fix?: string;
  resolved: boolean;
}

export interface WorkingMemory {
  repo_path: string | null;
  git_remote: string | null;
  git_branch: string | null;
  current_goal: string;
  acceptance_criteria: string[];
  active_files: ActiveFile[];
  key_decisions: KeyDecision[];
  discovered_constraints: string[];
  error_context: ErrorContext | null;
  project_stack: {
    language: string | null;
    framework: string | null;
    test_runner: string | null;
    package_manager: string | null;
    linting: string | null;
  };
}
