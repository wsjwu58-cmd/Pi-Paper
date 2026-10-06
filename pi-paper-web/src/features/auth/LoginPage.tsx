import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/Button'
import { Field, Input } from '@/components/ui/Input'
import { toastError } from '@/components/ui/Toast'
import { AuthShell } from './AuthShell'

export function LoginPage() {
  const login = useAuth((s) => s.login)
  const navigate = useNavigate()
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await login(account, password)
      navigate('/workspace')
    } catch (err) {
      toastError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell title="登录 VibePaper" subtitle="继续你的无限画布创作">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="邮箱 / 手机号">
          <Input value={account} onChange={(e) => setAccount(e.target.value)} required placeholder="you@example.com" />
        </Field>
        <Field label="密码">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="••••••" />
        </Field>
        <Button type="submit" disabled={busy} className="mt-2 w-full">
          {busy ? '登录中…' : '登录'}
        </Button>
        <p className="text-center text-[13px] text-[#666]">
          还没有账号？{' '}
          <Link to="/register" className="font-bold text-[#111] underline-offset-2 hover:underline">
            立即注册
          </Link>
        </p>
      </form>
    </AuthShell>
  )
}
