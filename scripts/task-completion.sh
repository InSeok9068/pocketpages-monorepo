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
    COMPREPLY=( $(compgen -W "start kill update install deploy rollback archive restore archives merge test lint tsc diag verify knip gitleaks index new css bundle generate format help" -- "$cur") )
    return
  fi

  if [[ $COMP_CWORD -eq 2 && "$cmd" == "update" ]]; then
    local update_targets
    update_targets="$("$script" __complete_update_targets 2>/dev/null)"
    COMPREPLY=( $(compgen -W "$update_targets" -- "$cur") )
    return
  fi

  if [[ $COMP_CWORD -eq 2 && "$cmd" == "install" ]]; then
    local install_targets
    install_targets="$("$script" __complete_install_targets 2>/dev/null)"
    COMPREPLY=( $(compgen -W "$install_targets" -- "$cur") )
    return
  fi

  if [[ $COMP_CWORD -eq 2 && ( "$cmd" == "start" || "$cmd" == "deploy" || "$cmd" == "rollback" || "$cmd" == "archive" || "$cmd" == "test" || "$cmd" == "lint" || "$cmd" == "tsc" || "$cmd" == "diag" || "$cmd" == "verify" || "$cmd" == "index" || "$cmd" == "css" ) ]]; then
    services="$("$script" __complete_services 2>/dev/null)"
    COMPREPLY=( $(compgen -W "$services" -- "$cur") )
    return
  fi

  if [[ $COMP_CWORD -eq 2 && ( "$cmd" == "restore" || "$cmd" == "archives" ) ]]; then
    local archive_services
    archive_services="$("$script" __complete_archive_services 2>/dev/null)"
    COMPREPLY=( $(compgen -W "$archive_services" -- "$cur") )
    return
  fi

  if [[ $COMP_CWORD -eq 3 && "$cmd" == "restore" ]]; then
    local archive_tags
    archive_tags="$("$script" __complete_archive_tags "${COMP_WORDS[2]}" 2>/dev/null)"
    COMPREPLY=( $(compgen -W "$archive_tags" -- "$cur") )
    return
  fi

  if [[ $COMP_CWORD -eq 3 && "$cmd" == "rollback" ]]; then
    COMPREPLY=( $(compgen -W "1 2 3" -- "$cur") )
    return
  fi

  if [[ $COMP_CWORD -eq 2 && "$cmd" == "merge" ]]; then
    local release_services
    release_services="$("$script" __complete_release_services 2>/dev/null)"
    COMPREPLY=( $(compgen -W "$release_services" -- "$cur") )
    return
  fi

  if [[ "$cmd" == "deploy" && $COMP_CWORD -ge 3 && "$cur" == --* ]]; then
    COMPREPLY=( $(compgen -W "--skip-verify" -- "$cur") )
    return
  fi

  if [[ "$cmd" == "gitleaks" && "$cur" == --* ]]; then
    COMPREPLY=( $(compgen -W "--staged --history --range --latest --ci --help" -- "$cur") )
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

  if [[ "$cmd" == "generate" ]]; then
    if [[ $COMP_CWORD -ge 3 && "${COMP_WORDS[COMP_CWORD-1]}" == "--service" ]]; then
      services="$("$script" __complete_services 2>/dev/null)"
      COMPREPLY=( $(compgen -W "$services" -- "$cur") )
      return
    fi

    if [[ $COMP_CWORD -ge 3 && "${COMP_WORDS[COMP_CWORD-1]}" == "--kind" ]]; then
      local generate_kinds
      generate_kinds="$("$script" __complete_generate_kinds 2>/dev/null)"
      COMPREPLY=( $(compgen -W "$generate_kinds" -- "$cur") )
      return
    fi

    if [[ $COMP_CWORD -ge 3 && "${COMP_WORDS[COMP_CWORD-1]}" == "--method" ]]; then
      COMPREPLY=( $(compgen -W "GET POST ANY" -- "$cur") )
      return
    fi

    if [[ "$cur" == --* || -z "$cur" ]]; then
      COMPREPLY=( $(compgen -W "--service --kind --path --method --auth --no-auth --partial --success-redirect --failure-redirect --force --dry-run --help" -- "$cur") )
      return
    fi
  fi

  if [[ "$cmd" == "new" ]]; then
    if [[ $COMP_CWORD -ge 3 && "${COMP_WORDS[COMP_CWORD-1]}" == "--features" ]]; then
      COMPREPLY=( $(compgen -W "htmx,alpine,unocss htmx alpine unocss datastar realtime none" -- "$cur") )
      return
    fi

    if [[ "$cur" == --* || -z "$cur" ]]; then
      COMPREPLY=( $(compgen -W "--service --auth --no-auth --features --install --skip-install --copy-binaries --skip-binaries --dry-run --help" -- "$cur") )
      return
    fi
  fi

  if [[ ( "$cmd" == "update" || "$cmd" == "install" ) && "$cur" == --* ]]; then
    local target
    target="${COMP_WORDS[2]}"

    if [[ "$cmd" == "update" && "$target" == "pocketbase" ]]; then
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
