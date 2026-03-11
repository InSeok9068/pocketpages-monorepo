#!/usr/bin/env bash

# Bash completion for ./task.sh
# Usage in ~/.bash_profile:
#   if [ -f "scripts/task-completion.sh" ]; then
#     source "scripts/task-completion.sh"
#   fi

_pp_dev_complete() {
  local cur cmd root script services
  cur="${COMP_WORDS[COMP_CWORD]}"
  cmd="${COMP_WORDS[1]}"

  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  script="$root/task.sh"

  if [[ ! -x "$script" ]]; then
    return
  fi

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "start kill lint format help" -- "$cur") )
    return
  fi

  if [[ $COMP_CWORD -eq 2 && ( "$cmd" == "start" || "$cmd" == "lint" ) ]]; then
    services="$("$script" __complete_services 2>/dev/null)"
    COMPREPLY=( $(compgen -W "$services" -- "$cur") )
    return
  fi
}

complete -F _pp_dev_complete task.sh
complete -F _pp_dev_complete ./task.sh
