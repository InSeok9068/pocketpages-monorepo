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
    COMPREPLY=( $(compgen -W "start kill update deploy rollback test lint diag verify index bundle format help" -- "$cur") )
    return
  fi

  if [[ $COMP_CWORD -eq 2 && "$cmd" == "update" ]]; then
    local update_targets
    update_targets="$("$script" __complete_update_targets 2>/dev/null)"
    COMPREPLY=( $(compgen -W "$update_targets" -- "$cur") )
    return
  fi

  if [[ $COMP_CWORD -eq 2 && ( "$cmd" == "start" || "$cmd" == "deploy" || "$cmd" == "rollback" || "$cmd" == "test" || "$cmd" == "lint" || "$cmd" == "diag" || "$cmd" == "verify" || "$cmd" == "index" ) ]]; then
    services="$("$script" __complete_services 2>/dev/null)"
    COMPREPLY=( $(compgen -W "$services" -- "$cur") )
    return
  fi

  if [[ $COMP_CWORD -eq 3 && "$cmd" == "rollback" ]]; then
    COMPREPLY=( $(compgen -W "1 2 3" -- "$cur") )
    return
  fi

  if [[ "$cmd" == "index" ]]; then
    if [[ "$cur" == --* ]]; then
      COMPREPLY=( $(compgen -W "--section --file --json --pretty" -- "$cur") )
      return
    fi

    if [[ $COMP_CWORD -ge 3 && "${COMP_WORDS[COMP_CWORD-1]}" == "--section" ]]; then
      local sections
      sections="$("$script" __complete_index_sections 2>/dev/null)"
      COMPREPLY=( $(compgen -W "$sections" -- "$cur") )
      return
    fi
  fi

  if [[ "$cmd" == "update" && "$cur" == --* ]]; then
    local target
    target="${COMP_WORDS[2]}"

    if [[ "$target" == "pocketbase" ]]; then
      COMPREPLY=( $(compgen -W "--backup --backup=false --help" -- "$cur") )
      return
    fi

    if [[ "$target" == "npm" ]]; then
      COMPREPLY=( $(compgen -W "--help" -- "$cur") )
      return
    fi
  fi
}

complete -F _pp_dev_complete task.sh
complete -F _pp_dev_complete ./task.sh
