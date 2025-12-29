import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const { serverUrl } = await request.json();

    if (!serverUrl) {
      return NextResponse.json(
        { success: false, error: '服务器地址不能为空' },
        { status: 400 },
      );
    }

    // 测试健康检查端点
    const healthUrl = `${serverUrl.replace(/\/$/, '')}/health`;

    const fetchHealth = async (url: string) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000); // 10秒超时
      try {
        return await fetch(url, {
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
          },
        });
      } finally {
        clearTimeout(timeout);
      }
    };

    const handleHealthResponse = async (response: Response) => {
      if (!response.ok) {
        return NextResponse.json({
          success: false,
          error: `健康检查失败: HTTP ${response.status}`,
        });
      }

      const data = await response.json();

      if (data.status === 'ok') {
        const uptimeMinutes = data.uptime ? Math.floor(data.uptime / 60) : 0;
        return NextResponse.json({
          success: true,
          message: `服务器连接成功，运行时长: ${uptimeMinutes} 分钟`,
        });
      }

      return NextResponse.json({
        success: false,
        error: '健康检查返回异常',
      });
    };

    try {
      const response = await fetchHealth(healthUrl);
      return await handleHealthResponse(response);
    } catch (fetchError: any) {
      const isAbort = fetchError?.name === 'AbortError';
      if (isAbort) {
        return NextResponse.json({
          success: false,
          error: '连接超时（10秒）',
        });
      }

      try {
        const parsed = new URL(serverUrl);
        const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(
          parsed.hostname,
        );
        if (process.env.DOCKER_ENV === 'true' && isLocalhost) {
          const internalUrl = new URL(healthUrl);
          internalUrl.hostname = 'watch-room-server';
          if (!internalUrl.port) {
            internalUrl.port = '3001';
          }
          const response = await fetchHealth(internalUrl.toString());
          return await handleHealthResponse(response);
        }
      } catch {
        // ignore URL parse errors
      }

      return NextResponse.json({
        success: false,
        error: `无法连接到服务器: ${fetchError.message}`,
      });
    }
  } catch (error: any) {
    console.error('测试连接失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '测试连接失败' },
      { status: 500 },
    );
  }
}
