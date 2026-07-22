;(function initializeWorkDetailEditors() {
  const tiptapRuntime = window.TodoTiptap

  if (!tiptapRuntime) {
    const fallbackInputs = document.querySelectorAll('[data-editor-input]')

    for (let index = 0; index < fallbackInputs.length; index += 1) {
      const input = fallbackInputs[index]

      input.hidden = false
      input.classList.add('work-rich-text-fallback')
    }

    return
  }

  const { CharacterCount, Editor, Highlight, Placeholder, StarterKit, Typography } = tiptapRuntime

  const ACTIVE_COMMANDS = {
    bold: (editor) => editor.isActive('bold'),
    italic: (editor) => editor.isActive('italic'),
    underline: (editor) => editor.isActive('underline'),
    strike: (editor) => editor.isActive('strike'),
    highlight: (editor) => editor.isActive('highlight'),
    'bullet-list': (editor) => editor.isActive('bulletList'),
    'ordered-list': (editor) => editor.isActive('orderedList'),
    blockquote: (editor) => editor.isActive('blockquote'),
    'code-block': (editor) => editor.isActive('codeBlock'),
    link: (editor) => editor.isActive('link'),
  }

  /**
   * 에디터 내용을 폼 필드에 반영합니다.
   *
   * @param {Editor} editor Tiptap 에디터
   * @param {HTMLTextAreaElement} input 저장 폼 필드
   */
  function syncContent(editor, input) {
    input.value = editor.isEmpty ? '' : editor.getHTML()
  }

  /**
   * 현재 선택 영역에 맞춰 툴바 상태를 갱신합니다.
   *
   * @param {HTMLElement} root 에디터 루트
   * @param {Editor} editor Tiptap 에디터
   */
  function updateToolbar(root, editor) {
    const buttons = root.querySelectorAll('[data-editor-command]')

    for (let index = 0; index < buttons.length; index += 1) {
      const button = buttons[index]
      const command = String(button.dataset.editorCommand || '')
      const activeCheck = ACTIVE_COMMANDS[command]
      const isActive = activeCheck ? activeCheck(editor) : false
      let isDisabled = false

      if (command === 'undo') isDisabled = !editor.can().chain().focus().undo().run()
      if (command === 'redo') isDisabled = !editor.can().chain().focus().redo().run()
      if (command === 'unlink') isDisabled = !editor.isActive('link')

      button.classList.toggle('is-active', isActive)
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false')
      button.disabled = isDisabled
    }

    const blockType = root.querySelector('[data-editor-block-type]')

    if (blockType) {
      if (editor.isActive('heading', { level: 1 })) blockType.value = 'heading-1'
      else if (editor.isActive('heading', { level: 2 })) blockType.value = 'heading-2'
      else blockType.value = 'paragraph'
    }

    const characterCount = root.querySelector('[data-editor-character-count]')

    if (characterCount) characterCount.textContent = String(editor.storage.characterCount.characters()) + '자'
  }

  /**
   * 링크 주소를 입력받아 현재 선택 영역에 적용합니다.
   *
   * @param {Editor} editor Tiptap 에디터
   */
  function editLink(editor) {
    const currentHref = String(editor.getAttributes('link').href || '')
    const nextHref = window.prompt('연결할 주소를 입력하세요.', currentHref)

    if (nextHref === null) return

    const href = nextHref.trim()

    if (!href) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      return
    }

    editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
  }

  /**
   * 툴바 명령을 실행합니다.
   *
   * @param {Editor} editor Tiptap 에디터
   * @param {string} command 명령 이름
   */
  function runCommand(editor, command) {
    if (command === 'bold') editor.chain().focus().toggleBold().run()
    else if (command === 'italic') editor.chain().focus().toggleItalic().run()
    else if (command === 'underline') editor.chain().focus().toggleUnderline().run()
    else if (command === 'strike') editor.chain().focus().toggleStrike().run()
    else if (command === 'highlight') editor.chain().focus().toggleHighlight().run()
    else if (command === 'bullet-list') editor.chain().focus().toggleBulletList().run()
    else if (command === 'ordered-list') editor.chain().focus().toggleOrderedList().run()
    else if (command === 'blockquote') editor.chain().focus().toggleBlockquote().run()
    else if (command === 'code-block') editor.chain().focus().toggleCodeBlock().run()
    else if (command === 'horizontal-rule') editor.chain().focus().setHorizontalRule().run()
    else if (command === 'link') editLink(editor)
    else if (command === 'unlink') editor.chain().focus().extendMarkRange('link').unsetLink().run()
    else if (command === 'clear-format') editor.chain().focus().unsetAllMarks().clearNodes().run()
    else if (command === 'undo') editor.chain().focus().undo().run()
    else if (command === 'redo') editor.chain().focus().redo().run()
  }

  /**
   * 업무 상세 리치 텍스트 에디터를 초기화합니다.
   *
   * @param {HTMLElement} root 에디터 루트
   */
  function initializeEditor(root) {
    const editorElement = root.querySelector('[data-editor-surface]')
    const input = root.querySelector('[data-editor-input]')

    if (!(editorElement instanceof HTMLElement) || !(input instanceof HTMLTextAreaElement)) return

    const editor = new Editor({
      element: editorElement,
      content: input.value || '<p></p>',
      extensions: [
        StarterKit.configure({
          heading: {
            levels: [1, 2],
          },
          link: {
            autolink: true,
            defaultProtocol: 'https',
            linkOnPaste: true,
            openOnClick: false,
            HTMLAttributes: {
              rel: 'noopener noreferrer nofollow',
              target: '_blank',
            },
          },
        }),
        Highlight,
        Typography,
        Placeholder.configure({
          placeholder: '내용을 입력하세요. 마크다운 입력 규칙도 사용할 수 있습니다.',
        }),
        CharacterCount,
      ],
      editorProps: {
        attributes: {
          'aria-label': '업무 내용 편집기',
          class: 'work-rich-text-content',
        },
      },
      onCreate: ({ editor: currentEditor }) => {
        syncContent(currentEditor, input)
        updateToolbar(root, currentEditor)
      },
      onSelectionUpdate: ({ editor: currentEditor }) => updateToolbar(root, currentEditor),
      onUpdate: ({ editor: currentEditor }) => {
        syncContent(currentEditor, input)
        updateToolbar(root, currentEditor)
      },
    })

    root.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-editor-command]') : null

      if (!(target instanceof HTMLButtonElement)) return

      event.preventDefault()
      runCommand(editor, String(target.dataset.editorCommand || ''))
      updateToolbar(root, editor)
    })

    const blockType = root.querySelector('[data-editor-block-type]')

    if (blockType instanceof HTMLSelectElement) {
      blockType.addEventListener('change', () => {
        if (blockType.value === 'heading-1') editor.chain().focus().setHeading({ level: 1 }).run()
        else if (blockType.value === 'heading-2') editor.chain().focus().setHeading({ level: 2 }).run()
        else editor.chain().focus().setParagraph().run()
        updateToolbar(root, editor)
      })
    }

    if (input.form) input.form.addEventListener('submit', () => syncContent(editor, input))
  }

  const editorRoots = document.querySelectorAll('[data-work-rich-text]')

  for (let index = 0; index < editorRoots.length; index += 1) initializeEditor(editorRoots[index])
})()
