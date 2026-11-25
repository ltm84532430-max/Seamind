import {
  TerminalWorkspace,
  type TerminalWorkspaceProps,
} from './TerminalWorkspace';

export type FocusedWorkspaceProps = Omit<
  TerminalWorkspaceProps,
  'workspaceFocus' | 'initialKind'
>;

export function LabWorkspace(props: FocusedWorkspaceProps) {
  return (
    <TerminalWorkspace
      {...props}
      workspaceFocus="lab"
      initialKind="lab"
      initialLabLanguage={props.initialLabLanguage ?? 'python'}
    />
  );
}

export function AgentWorkspace(props: FocusedWorkspaceProps) {
  return (
    <TerminalWorkspace {...props} workspaceFocus="agent" initialKind="agent" />
  );
}

export function ShellWorkspace(props: FocusedWorkspaceProps) {
  return (
    <TerminalWorkspace {...props} workspaceFocus="shell" initialKind="shell" />
  );
}
